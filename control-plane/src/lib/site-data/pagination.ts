import { DataError, name } from "./validation";

export type Column = "id" | "createdAt" | "updatedAt";
export type Direction = "asc" | "desc";
export type Sort = {
  /** Cursor identity: the caller's orderBy verbatim. */
  orderBy: string;
  direction: Direction;
  /** The physical column an `orderBy` of `id`/`createdAt`/`updatedAt` reads. */
  column: string;
  /** Set when ordering by a document field rather than a column. */
  field?: string;
};
/** Server metadata is camelCase on the wire and snake_case in PostgreSQL. */
const COLUMNS: Record<Column, string> = {
  id: "id",
  createdAt: "created_at",
  updatedAt: "updated_at",
};
const DATA_ORDER = /^data\.([a-zA-Z0-9_-]{1,64})$/;
/** Distinguishes document cursors from media cursors so neither decodes the
 * other, even when a collection id and a user id happen to be the same number. */
export type CursorKind = "d" | "f";

export function sorting(orderBy = "id", direction = "asc"): Sort {
  if (!["asc", "desc"].includes(direction))
    throw new DataError(400, "Use direction=asc or desc.");
  const field = DATA_ORDER.exec(orderBy)?.[1];
  if (!field && !Object.hasOwn(COLUMNS, orderBy))
    throw new DataError(
      400,
      "Use orderBy=id, createdAt, updatedAt or data.<field>.",
    );
  return {
    orderBy,
    direction: direction as Direction,
    column: field ? "" : COLUMNS[orderBy as Column],
    field,
  };
}

/** One wire form: a JSON array of one or two [field, direction] pairs. The
 * document id is always the final stable tie-breaker, so it may only be named
 * on its own. Without orderBy a query reads in id order. */
export function sortings(raw?: string): Sort[] {
  if (raw === undefined) return [sorting()];
  let input: unknown;
  try {
    input = JSON.parse(raw);
  } catch {
    input = undefined;
  }
  if (
    !Array.isArray(input) ||
    input.length < 1 ||
    input.length > 2 ||
    input.some(
      (item) =>
        !Array.isArray(item) ||
        item.length !== 2 ||
        typeof item[0] !== "string" ||
        (item[1] !== "asc" && item[1] !== "desc"),
    )
  )
    throw new DataError(
      400,
      'orderBy must be a JSON array of one or two [field, direction] pairs, such as [["createdAt","desc"]].',
    );
  const result = (input as [string, Direction][]).map(
    ([field, itemDirection]) => sorting(field, itemDirection),
  );
  if (new Set(result.map((item) => item.orderBy)).size !== result.length)
    throw new DataError(400, "orderBy fields must be unique.");
  if (result.length > 1 && result.some((item) => item.orderBy === "id"))
    throw new DataError(
      400,
      "The document id is already the final tie-breaker.",
    );
  return result;
}

export function encodeCursor(
  scope: number,
  sort: Sort,
  id: string,
  value: string | null,
  fingerprint?: string,
  kind: CursorKind = "d",
) {
  return (
    "v1." +
    Buffer.from(
      JSON.stringify({
        c: scope,
        s: sort.orderBy,
        d: sort.direction,
        i: id,
        t: value,
        f: fingerprint,
        ...(kind === "d" ? {} : { k: kind }),
      }),
    ).toString("base64url")
  );
}
export function decodeCursor(
  pageToken: string | undefined,
  scope: number,
  sort: Sort,
  fingerprint?: string,
  kind: CursorKind = "d",
) {
  if (pageToken === undefined) return null;
  try {
    if (pageToken.length > 1024 || !/^v1\.[A-Za-z0-9_-]+$/.test(pageToken))
      throw new Error();
    const cursor = JSON.parse(
      Buffer.from(pageToken.slice(3), "base64url").toString("utf8"),
    );
    if (
      cursor.c !== scope ||
      cursor.s !== sort.orderBy ||
      cursor.d !== sort.direction ||
      cursor.f !== fingerprint ||
      (cursor.k ?? "d") !== kind
    )
      throw new Error();
    name(cursor.i);
    if (sort.field) {
      // The anchor is the field's JSONB text, compared as JSONB again on the
      // way in, so PostgreSQL's own rendering round-trips exactly.
      if (typeof cursor.t !== "string") throw new Error();
      JSON.parse(cursor.t);
    } else if (sort.orderBy === "id") {
      if (cursor.t !== null) throw new Error();
    } else {
      // Preserve PostgreSQL microseconds; Date alone would lose cursor precision.
      if (
        typeof cursor.t !== "string" ||
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(cursor.t) ||
        new Date(cursor.t).toISOString() !== cursor.t.slice(0, 23) + "Z"
      )
        throw new Error();
    }
    return { id: cursor.i as string, value: cursor.t as string | null };
  } catch {
    throw new DataError(
      400,
      "Invalid cursor or cursor does not match this collection, sort order and filters.",
    );
  }
}

export function encodeMultiCursor(
  scope: number,
  sorts: Sort[],
  id: string,
  values: string[],
  fingerprint?: string,
) {
  return (
    "v2." +
    Buffer.from(
      JSON.stringify({
        c: scope,
        s: sorts.map(({ orderBy, direction }) => [orderBy, direction]),
        i: id,
        t: values,
        f: fingerprint,
      }),
    ).toString("base64url")
  );
}

export function decodeMultiCursor(
  pageToken: string | undefined,
  scope: number,
  sorts: Sort[],
  fingerprint?: string,
) {
  if (pageToken === undefined) return null;
  try {
    if (pageToken.length > 2048 || !/^v2\.[A-Za-z0-9_-]+$/.test(pageToken))
      throw new Error();
    const cursor = JSON.parse(
      Buffer.from(pageToken.slice(3), "base64url").toString("utf8"),
    );
    const identity = sorts.map(({ orderBy, direction }) => [
      orderBy,
      direction,
    ]);
    if (
      cursor.c !== scope ||
      JSON.stringify(cursor.s) !== JSON.stringify(identity) ||
      cursor.f !== fingerprint ||
      !Array.isArray(cursor.t) ||
      cursor.t.length !== sorts.length
    )
      throw new Error();
    name(cursor.i);
    for (let index = 0; index < sorts.length; index += 1) {
      const sort = sorts[index];
      const value = cursor.t[index];
      if (typeof value !== "string") throw new Error();
      if (sort.field) JSON.parse(value);
      else if (sort.orderBy === "id") throw new Error();
      else if (
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(value) ||
        new Date(value).toISOString() !== value.slice(0, 23) + "Z"
      )
        throw new Error();
    }
    return { id: cursor.i as string, values: cursor.t as string[] };
  } catch {
    throw new DataError(
      400,
      "Invalid cursor or cursor does not match this collection, sort order and filters.",
    );
  }
}
