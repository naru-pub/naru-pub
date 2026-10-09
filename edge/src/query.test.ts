import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, test } from "vitest";
import { cursorMs, cursorTime, listQuery, SCHEMA, type Row } from "./query";
import type { ListInput } from "./types";

// The list query against SQLite in plain Node, with the object's own schema:
// Naru's ordering across JSON types, filters, and cursor paging, checked
// against what the v1 protocol specifies rather than against itself.

const COLLECTION = "0190f5a0-0000-7000-8000-000000000001";
let db: DatabaseSync;

/** Every page of a query, following its cursors. */
function readAll(input: ListInput) {
  const ids: string[] = [];
  let after: string | undefined;
  for (let pages = 0; pages < 100; pages += 1) {
    const query = listQuery(COLLECTION, { ...input, after });
    const rows = db
      .prepare(query.select.sql)
      .all(...(query.select.bindings as (string | number | null)[])) as Row[];
    const page = query.page(rows);
    ids.push(...page.documents.map((document) => document.id));
    if (!page.nextCursor) return ids;
    after = page.nextCursor;
  }
  throw new Error("Paging did not end.");
}
const total = (input: ListInput) => {
  const query = listQuery(COLLECTION, { ...input, includeTotal: true });
  return Number(
    (
      db
        .prepare(query.count!.sql)
        .get(...(query.count!.bindings as (string | number)[])) as Row
    ).matched,
  );
};
const sort = (...pairs: [unknown, "asc" | "desc"][]) => JSON.stringify(pairs);
const createdAt = { metadata: "createdAt" };
const updatedAt = { metadata: "updatedAt" };

/** One value of every kind the ordering separates, under field `v`. */
const VALUES: [string, unknown][] = [
  ["missing", undefined],
  ["null", null],
  ["array", [1]],
  ["object", { a: 1 }],
  ["empty", ""],
  ["upper", "APPLE"],
  ["title", "Apple"],
  ["lower", "apple"],
  ["umlaut", "äpple"],
  ["emoji", "😀"],
  ["text10", "10"],
  ["text9", "9"],
  ["negative", -1],
  ["zero", 0],
  ["one", 1],
  ["half", 1.5],
  ["nine", 9],
  ["ten", 10],
  ["huge", 1e21],
  ["false", false],
  ["true", true],
];
const BASE = Date.parse("2026-01-01T00:00:00Z");

/** The ordering the protocol specifies, computed independently of SQL. */
function rank(value: unknown) {
  if (typeof value === "string") return 1;
  if (typeof value === "number") return 2;
  if (typeof value === "boolean") return 3;
  return 0;
}
const bytes = (a: string, b: string) =>
  Buffer.compare(Buffer.from(a), Buffer.from(b));
function compare(a: [string, unknown], b: [string, unknown]) {
  const [x, y] = [a[1], b[1]];
  return (
    rank(x) - rank(y) ||
    (typeof x === "string" && typeof y === "string" ? bytes(x, y) : 0) ||
    (typeof x === "number" && typeof y === "number" ? x - y : 0) ||
    (typeof x === "boolean" && typeof y === "boolean"
      ? Number(x) - Number(y)
      : 0) ||
    bytes(a[0], b[0])
  );
}

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  db.exec(SCHEMA);
  const insert = db.prepare(
    "INSERT INTO documents (collection_id, id, data, size_bytes, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?)",
  );
  VALUES.forEach(([id, value], index) => {
    const data = {
      ...(value === undefined ? {} : { v: value }),
      group: index % 2 ? "odd" : "even",
    };
    // Every third document shares a creation millisecond with the next.
    const created = BASE + Math.floor(index / 3) * 1000;
    insert.run(
      COLLECTION,
      id,
      JSON.stringify(data),
      created,
      BASE + (VALUES.length - index) * 1000,
    );
  });
  // Another collection's documents never appear.
  insert.run("other", "elsewhere", '{"v":"apple"}', BASE, BASE);
});

describe("ordering", () => {
  test("orders every JSON type as the protocol specifies, both ways", () => {
    const ascending = [...VALUES].sort(compare).map(([id]) => id);
    expect(readAll({ sort: sort(["v", "asc"]), size: 100 })).toEqual(ascending);
    expect(readAll({ sort: sort(["v", "desc"]), size: 100 })).toEqual(
      [...ascending].reverse(),
    );
  });

  test("reads in id order without a sort, by bytes", () => {
    expect(readAll({ size: 100 })).toEqual(
      VALUES.map(([id]) => id).sort(bytes),
    );
  });

  test.each([
    ["field ascending", sort(["v", "asc"])],
    ["field descending", sort(["v", "desc"])],
    ["created, with ties", sort([createdAt, "desc"])],
    ["updated", sort([updatedAt, "asc"])],
    ["two fields", sort(["group", "asc"], ["v", "desc"])],
    ["field, then time", sort(["v", "asc"], [createdAt, "desc"])],
    ["id", undefined],
  ])("pages of any size add up to the whole ordering: %s", (_, order) => {
    const whole = readAll({ sort: order, size: 100 });
    expect(whole).toHaveLength(VALUES.length);
    for (const size of [1, 2, 3, 7])
      expect(readAll({ sort: order, size })).toEqual(whole);
  });
});

describe("filters", () => {
  test("equality matches the exact JSON type; null is not missing", () => {
    expect(readAll({ filter: { v: "apple" } })).toEqual(["lower"]);
    expect(readAll({ filter: { v: 1 } })).toEqual(["one"]);
    expect(readAll({ filter: { v: "10" } })).toEqual(["text10"]);
    expect(readAll({ filter: { v: null } })).toEqual(["null"]);
    expect(readAll({ filter: { v: true } })).toEqual(["true"]);
    expect(readAll({ filter: { v: false } })).toEqual(["false"]);
  });

  test("ranges compare within the bound's own type", () => {
    expect(
      readAll({ filter: { v: { gte: 0, lt: 10 } }, sort: sort(["v", "asc"]) }),
    ).toEqual(["zero", "one", "half", "nine"]);
    expect(
      readAll({ filter: { v: { gte: "a" } }, sort: sort(["v", "asc"]) }),
    ).toEqual(["lower", "umlaut", "emoji"]);
  });

  test("conditions combine, and totals ignore the page size", () => {
    const filter = { group: "even", v: { gt: 0 } };
    const matched = readAll({ filter, size: 100 });
    expect(matched).toEqual(
      VALUES.filter(
        ([, value], index) =>
          index % 2 === 0 && typeof value === "number" && value > 0,
      )
        .map(([id]) => id)
        .sort(bytes),
    );
    expect(total({ filter, size: 1 })).toBe(matched.length);
    expect(readAll({ filter, size: 1 })).toEqual(matched);
  });
});

describe("cursors and limits", () => {
  test("a time cursor keeps the six-digit form and comes back to the same instant", () => {
    const at = BASE + 123;
    expect(cursorTime(at)).toBe("2026-01-01T00:00:00.123000Z");
    expect(cursorMs(cursorTime(at))).toBe(at);
  });

  test("a cursor only continues the query it came from", () => {
    const query = listQuery(COLLECTION, { sort: sort(["v", "asc"]), size: 1 });
    const rows = db
      .prepare(query.select.sql)
      .all(...(query.select.bindings as (string | number)[])) as Row[];
    const after = query.page(rows).nextCursor!;
    for (const other of [
      { sort: sort(["v", "desc"]), after },
      { sort: sort(["v", "asc"]), filter: { group: "odd" }, after },
    ])
      expect(() => listQuery(COLLECTION, other)).toThrow(
        expect.objectContaining({ status: 400 }),
      );
    expect(() =>
      listQuery("another", { sort: sort(["v", "asc"]), after }),
    ).toThrow(expect.objectContaining({ status: 400 }));
  });

  test.each([0, 101, 1.5])("refuses a page size of %s", (size) => {
    expect(() => listQuery(COLLECTION, { size })).toThrow(
      expect.objectContaining({ status: 400 }),
    );
  });
});
