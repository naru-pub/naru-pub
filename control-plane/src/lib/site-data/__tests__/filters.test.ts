/** @jest-environment node */
import {
  beforeAll,
  beforeEach,
  afterAll,
  describe,
  test,
  expect,
} from "@jest/globals";
import { sql } from "kysely";
import { db } from "@/lib/database";
import { executeData } from "../service";
import { filters, parseWhereQuery } from "../filters";
import { setupTestDatabase, teardownTestDatabase } from "./test-database";
import {
  down,
  up,
} from "@/migrations/1788205003689_add_site_data_filter_index";

describe("filter validation", () => {
  test.each([
    null,
    [],
    "x",
    { nested: { x: 1 } },
    { list: [1] },
    { "a.b": 1 },
    { number: Infinity },
    { number: NaN },
    { text: "\u0000" },
    { text: "\ud800" },
    { text: "x".repeat(2048) },
    { a: 1, b: 2, c: 3, d: 4, e: 5, f: 6 },
  ])("rejects unsupported filter %p", (where) => {
    expect(() => filters(where)).toThrow();
  });
  test("normalizes key order and distinguishes value types", () => {
    expect(filters({ b: 2, a: "1" }).fingerprint).toEqual(
      filters({ a: "1", b: 2 }).fingerprint,
    );
    expect(filters({ a: 1 }).fingerprint).not.toEqual(
      filters({ a: "1" }).fingerprint,
    );
    expect(filters({}).fingerprint).toBeUndefined();
    expect(() => parseWhereQuery("{")).toThrow();
    expect(() => parseWhereQuery(" ".repeat(2049))).toThrow();
  });
});
const integration =
  process.env.NARU_DATA_TEST === "1" ? describe : describe.skip;
integration("indexed filtered queries", () => {
  let ready = false,
    owner: number;
  const call = (method: string, path: string[], extra = {}) =>
    executeData({
      site: "filter-test",
      method,
      path,
      adminUserId: owner,
      ...extra,
    });
  beforeAll(async () => {
    await setupTestDatabase();
    ready = true;
    owner = (
      await sql<{
        id: number;
      }>`insert into users(login_name) values ('filter-test') returning id`.execute(
        db,
      )
    ).rows[0].id;
  });
  beforeEach(async () => {
    await db.deleteFrom("site_data_collections").execute();
    await call("POST", [], { body: { name: "posts", read: "world" } });
    const rows: [string, unknown][] = [
      [
        "a",
        {
          category: "일상",
          postId: "one",
          count: 1,
          active: true,
          optional: null,
        },
      ],
      ["b", { category: "개발", postId: "one", count: "1", active: false }],
      [
        "c",
        {
          category: "일상",
          postId: "two",
          count: 2,
          active: true,
          optional: null,
        },
      ],
      ["d", { category: ["일상"], postId: "one" }],
      ["e", [{ category: "일상" }]],
      ["f", null],
      ["g", { category: { name: "일상" } }],
      ["h", { category: "x' OR true --" }],
    ];
    for (const [id, data] of rows)
      await call("PUT", ["posts", id], { body: { data } });
  });
  afterAll(async () => {
    if (ready) await teardownTestDatabase();
    await db.destroy();
  });
  test("matches scalar types exactly, ANDs fields, excludes missing/null/array confusion", async () => {
    for (const [where, ids] of [
      [{ category: "일상" }, ["a", "c"]],
      [{ category: "일상", postId: "one" }, ["a"]],
      [{ count: 1 }, ["a"]],
      [{ count: "1" }, ["b"]],
      [{ active: false }, ["b"]],
      [{ optional: null }, ["a", "c"]],
      [{ category: "x' OR true --" }, ["h"]],
      [{ category: "없음" }, []],
    ] as const) {
      const result = await call("GET", ["posts"], {
        where,
        adminUserId: undefined,
      });
      expect(result.documents!.map((d) => d.id)).toEqual(ids);
    }
  });
  test("filtered pagination binds query fingerprint and accepts reordered equivalent filters", async () => {
    const sort = { orderBy: "created_at", direction: "desc" };
    const first = await call("GET", ["posts"], {
      ...sort,
      where: { category: "일상", active: true },
      limit: 1,
    });
    expect(first.documents![0].id).toBe("c");
    const next = await call("GET", ["posts"], {
      ...sort,
      where: { active: true, category: "일상" },
      after: first.nextCursor,
    });
    expect(next.documents!.map((d) => d.id)).toEqual(["a"]);
    expect(next.nextCursor).toBeNull();
    for (const where of [
      undefined,
      {},
      { category: "개발" },
      { category: "일상" },
    ])
      await expect(
        call("GET", ["posts"], { ...sort, where, after: first.nextCursor }),
      ).rejects.toMatchObject({ status: 400 });
    await expect(
      call("GET", ["posts"], { where: { category: "일상" }, after: "a" }),
    ).rejects.toMatchObject({ status: 400 });
    const plain = await call("GET", ["posts"], { limit: 1 });
    await expect(
      call("GET", ["posts"], {
        where: { category: "일상" },
        after: plain.nextCursor,
      }),
    ).rejects.toMatchObject({ status: 400 });
  });
  test("filters never widen read permissions and index stays current after replacements", async () => {
    await call("PUT", ["posts", "a"], { body: { data: { category: "개발" } } });
    expect(
      (
        await call("GET", ["posts"], { where: { category: "일상" } })
      ).documents!.map((d) => d.id),
    ).toEqual(["c"]);
    await call("DELETE", ["posts", "c"]);
    expect(
      (await call("GET", ["posts"], { where: { category: "일상" } })).documents,
    ).toEqual([]);
    await call("PATCH", ["posts"], { body: { read: "admin", write: "admin" } });
    await expect(
      call("GET", ["posts"], {
        where: { category: "개발" },
        adminUserId: undefined,
      }),
    ).rejects.toMatchObject({ status: 403 });
  });
  test("automatic GIN index supports the filter predicate; rollback preserves documents", async () => {
    const plan = await db.transaction().execute(async (tx) => {
      await sql`set local enable_seqscan=off`.execute(tx);
      return sql`explain (format json) select id from site_data_documents where data @> '{"category":"일상"}'::jsonb`.execute(
        tx,
      );
    });
    expect(JSON.stringify(plan.rows)).toContain("site_data_documents_data_idx");
    await down(db);
    await up(db);
    expect(
      (await call("GET", ["posts"], { where: { category: "일상" } })).documents,
    ).toHaveLength(2);
  });
});
