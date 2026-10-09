import { DataError } from "../../control-plane/src/lib/site-data/validation";
import {
  COMPARISONS,
  filters,
} from "../../control-plane/src/lib/site-data/filters";
import {
  decodeCursor,
  decodeMultiCursor,
  encodeCursor,
  encodeMultiCursor,
  sortings,
  type Sort,
} from "../../control-plane/src/lib/site-data/pagination";
import type { ListInput } from "./types";

// The SQL of a site's object (site.ts), as pure functions: its tables, and
// the list query with Naru's ordering, filters and cursors. Nothing here
// touches storage, so query.test.ts runs it against SQLite in plain Node.

/** A value SQLite binds or returns; the Workers runtime's SqlStorageValue. */
export type SqlValue = ArrayBuffer | string | number | null;
export type Row = Record<string, SqlValue>;

export const SCHEMA = `
  CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS collections (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    read_access TEXT NOT NULL,
    write_access TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS documents (
    collection_id TEXT NOT NULL,
    id TEXT NOT NULL,
    data TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,
    version INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (collection_id, id)
  );
  CREATE INDEX IF NOT EXISTS documents_created ON documents (collection_id, created_at, id);
  CREATE INDEX IF NOT EXISTS documents_updated ON documents (collection_id, updated_at, id);
  CREATE TABLE IF NOT EXISTS rate_limits (
    key TEXT PRIMARY KEY,
    window_start INTEGER NOT NULL,
    count INTEGER NOT NULL
  );
`;

/** Preserve the existing six-digit timestamp cursor format; storage is ms. */
export const cursorTime = (ms: number) =>
  new Date(ms).toISOString().replace("Z", "000Z");
export const cursorMs = (value: string) => Date.parse(value.slice(0, 23) + "Z");

// Naru ordering: null/missing/non-scalars, strings, numbers, booleans. The
// four scalar keys are represented as SQLite columns.
// Strings compare as bytes (SQLite's BINARY collation).
// `field` has passed NAME, so it cannot close the quoted JSON path.
const jsonPath = (field: string) => `'$."${field}"'`;
function fieldOrder(field: string) {
  const type = `json_type(data, ${jsonPath(field)})`;
  const value = `json_extract(data, ${jsonPath(field)})`;
  return [
    `CASE ${type} WHEN 'text' THEN 1 WHEN 'integer' THEN 2 WHEN 'real' THEN 2 WHEN 'true' THEN 3 WHEN 'false' THEN 3 ELSE 0 END`,
    `CASE WHEN ${type} = 'text' THEN ${value} ELSE '' END`,
    `CASE WHEN ${type} IN ('integer', 'real') THEN ${value} ELSE 0 END`,
    `CASE WHEN ${type} = 'true' THEN 1 ELSE 0 END`,
  ];
}
/** The same four keys for a cursor's JSON text, computed here and bound. */
function cursorOrder(text: string): SqlValue[] {
  const value: unknown = JSON.parse(text);
  const rank =
    typeof value === "string"
      ? 1
      : typeof value === "number"
        ? 2
        : typeof value === "boolean"
          ? 3
          : 0;
  return [
    rank,
    typeof value === "string" ? value : "",
    typeof value === "number" ? value : 0,
    value === true ? 1 : 0,
  ];
}
const COLUMNS: Record<string, string> = {
  id: "id",
  createdAt: "created_at",
  updatedAt: "updated_at",
};
const sortKeys = (sort: Sort) =>
  sort.field ? fieldOrder(sort.field) : [COLUMNS[sort.orderBy]];
function cursorKeys(sort: Sort, value: string | null): SqlValue[] {
  if (sort.field) return cursorOrder(value!);
  return [cursorMs(value!)];
}
const tuple = (keys: string[]) =>
  keys.length === 1 ? keys[0] : `(${keys.join(", ")})`;
const placeholders = (count: number) =>
  count === 1 ? "?" : `(${Array(count).fill("?").join(", ")})`;

/** Filters address top-level fields of a document's `data`. */
function filterConditions(filter: ReturnType<typeof filters>) {
  const conditions: string[] = [];
  const bindings: SqlValue[] = [];
  for (const [field, value] of filter.entries) {
    const type = `json_type(data, ${jsonPath(field)})`;
    const extracted = `json_extract(data, ${jsonPath(field)})`;
    // An explicit null matches; a missing field does not.
    if (value === null) conditions.push(`${type} = 'null'`);
    else if (typeof value === "boolean")
      conditions.push(`${type} = '${value ? "true" : "false"}'`);
    else if (typeof value === "string") {
      conditions.push(`${type} = 'text' AND ${extracted} = ?`);
      bindings.push(value);
    } else {
      conditions.push(`${type} IN ('integer', 'real') AND ${extracted} = ?`);
      bindings.push(value);
    }
  }
  for (const [field, operator, bound] of filter.ranges) {
    // Ranges compare within the bound's own JSON type.
    const type = `json_type(data, ${jsonPath(field)})`;
    conditions.push(
      `${type} ${typeof bound === "string" ? "= 'text'" : "IN ('integer', 'real')"} AND json_extract(data, ${jsonPath(field)}) ${COMPARISONS[operator]} ?`,
    );
    bindings.push(bound);
  }
  return { conditions, bindings };
}

/** A stored document as the protocol reports it. */
export function documentOf(row: Row) {
  return {
    id: row.id as string,
    data: JSON.parse(row.data as string),
    version: Number(row.version),
    createdAt: new Date(Number(row.created_at)).toISOString(),
    updatedAt: new Date(Number(row.updated_at)).toISOString(),
  };
}

type Query = { sql: string; bindings: SqlValue[] };

/**
 * One page of a collection: the statement to run (one row more than the page,
 * to tell whether another follows), the count to run when the total was asked
 * for, and `page`, which turns the statement's rows into the documents and
 * next cursor.
 */
export function listQuery(collectionId: string, input: ListInput) {
  const filter = filters(input.filter);
  const { conditions, bindings } = filterConditions(filter);
  const limit = input.size ?? 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100)
    throw new DataError(400, "Page size must be 1–100.");
  const sorts = sortings(input.sort);
  const sort = sorts[0];
  const multiple = sorts.length > 1;
  const cursor = multiple
    ? decodeMultiCursor(input.after, collectionId, sorts, filter.fingerprint)
    : decodeCursor(input.after, collectionId, sort, filter.fingerprint);
  const keys = sorts.map(sortKeys);
  const where = ["collection_id = ?", ...conditions];
  const whereBindings: SqlValue[] = [collectionId, ...bindings];
  const order = sorts.flatMap((item, index) =>
    keys[index].map((key) => `${key} ${item.direction.toUpperCase()}`),
  );
  if (!sorts.some((item) => item.orderBy === "id"))
    order.push(`id ${sorts.at(-1)!.direction.toUpperCase()}`);
  const pageWhere = [...where];
  const pageBindings = [...whereBindings];
  if (cursor) {
    if (!multiple) {
      const single = cursor as { id: string; value: string | null };
      const comparison = sort.direction === "asc" ? ">" : "<";
      if (sort.orderBy === "id") {
        pageWhere.push(`id ${comparison} ?`);
        pageBindings.push(single.id);
      } else {
        const bound = [...cursorKeys(sort, single.value), single.id];
        pageWhere.push(
          `(${[...keys[0], "id"].join(", ")}) ${comparison} ${placeholders(bound.length)}`,
        );
        pageBindings.push(...bound);
      }
    } else {
      const multi = cursor as { id: string; values: string[] };
      const values = sorts.map((item, index) =>
        cursorKeys(item, multi.values[index]),
      );
      const branches: string[] = [];
      for (let index = 0; index <= sorts.length; index += 1) {
        const parts: string[] = [];
        for (
          let before = 0;
          before < Math.min(index, sorts.length);
          before += 1
        ) {
          parts.push(
            `${tuple(keys[before])} = ${placeholders(values[before].length)}`,
          );
          pageBindings.push(...values[before]);
        }
        if (index < sorts.length) {
          const comparison = sorts[index].direction === "asc" ? ">" : "<";
          parts.push(
            `${tuple(keys[index])} ${comparison} ${placeholders(values[index].length)}`,
          );
          pageBindings.push(...values[index]);
        } else {
          parts.push(`id ${sorts.at(-1)!.direction === "asc" ? ">" : "<"} ?`);
          pageBindings.push(multi.id);
        }
        branches.push(`(${parts.join(" AND ")})`);
      }
      pageWhere.push(`(${branches.join(" OR ")})`);
    }
  }
  // Cursor values: a field's JSON text, or a six-digit timestamp.
  const cursorColumns = sorts.map((item, index) =>
    item.orderBy === "id"
      ? `NULL AS cursor_value_${index}`
      : item.field
        ? `coalesce(data -> ${jsonPath(item.field)}, 'null') AS cursor_value_${index}`
        : `${COLUMNS[item.orderBy]} AS cursor_value_${index}`,
  );
  const select: Query = {
    sql: `SELECT id, data, version, created_at, updated_at, ${cursorColumns.join(", ")}
       FROM documents WHERE ${pageWhere.join(" AND ")}
       ORDER BY ${order.join(", ")} LIMIT ?`,
    bindings: [...pageBindings, limit + 1],
  };
  const count: Query | null = input.includeTotal
    ? {
        sql: `SELECT count(*) AS matched FROM documents WHERE ${where.join(" AND ")}`,
        bindings: whereBindings,
      }
    : null;
  const cursorValue = (row: Row, index: number) => {
    const value = row[`cursor_value_${index}`];
    const item = sorts[index];
    if (item.orderBy === "id") return null;
    return item.field ? (value as string) : cursorTime(Number(value));
  };
  const page = (rows: Row[]) => {
    const shown = rows.slice(0, limit);
    const last = shown.at(-1);
    return {
      documents: shown.map(documentOf),
      nextCursor:
        rows.length > limit && last
          ? multiple
            ? encodeMultiCursor(
                collectionId,
                sorts,
                last.id as string,
                sorts.map((_, index) => cursorValue(last, index) as string),
                filter.fingerprint,
              )
            : encodeCursor(
                collectionId,
                sort,
                last.id as string,
                cursorValue(last, 0),
                filter.fingerprint,
              )
          : null,
    };
  };
  return { select, count, page };
}
