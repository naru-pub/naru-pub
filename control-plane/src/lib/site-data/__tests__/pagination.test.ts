/** @jest-environment node */
import {
  beforeAll,
  afterAll,
  beforeEach,
  describe,
  expect,
  test,
} from "@jest/globals";
import { sql } from "kysely";
import { db } from "@/lib/database";
import { executeData } from "../service";
import { setupTestDatabase, teardownTestDatabase } from "./test-database";
import { down, up } from "@/migrations/1788180032055_add_site_data_created_at";

// The wire form of one sort key.
// Tests name keys the way cursors do; the wire names metadata explicitly.
const order = (field: string, direction = "asc") =>
  JSON.stringify([[sortField(field), direction]]);
function sortField(field: string) {
  if (["id", "createdAt", "updatedAt"].includes(field))
    return { metadata: field };
  return field.startsWith("data.") ? field.slice(5) : field;
}
const integration =
  process.env.NARU_DATA_TEST === "1" ? describe : describe.skip;
integration("sorted database pagination", () => {
  let ready = false,
    owner: string;
  const call = (method: string, path: string[], extra = {}) =>
    executeData({
      site: "sorting",
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
        id: string;
      }>`insert into users(login_name) values ('sorting') returning id`.execute(
        db,
      )
    ).rows[0].id;
  });
  beforeEach(async () => {
    await db.deleteFrom("site_data_collections").execute();
    await call("POST", [], { body: { name: "posts", read: "world" } });
    for (const [id, time] of [
      ["a", "2026-08-01T00:00:00.000001Z"],
      ["b", "2026-08-01T00:00:00.000002Z"],
      ["c", "2026-08-01T00:00:00.000002Z"],
      ["d", "2026-08-01T00:00:00.000003Z"],
    ]) {
      await call("PUT", ["posts", id], { body: { data: { title: id } } });
      await sql`update site_data_documents set created_at=${time}::timestamptz, updated_at=${time}::timestamptz where id=${id}`.execute(
        db,
      );
    }
  });
  afterAll(async () => {
    if (ready) await teardownTestDatabase();
    await db.destroy();
  });
  test.each(["id", "createdAt", "updatedAt"])(
    "%s traversal handles ties and submillisecond precision in both directions",
    async (orderBy) => {
      for (const direction of ["asc", "desc"]) {
        const ids: string[] = [];
        let pageToken: string | undefined;
        do {
          const page = await call("GET", ["posts"], {
            sort: order(orderBy, direction),
            size: 1,
            after: pageToken,
            adminUserId: undefined,
          });
          ids.push(...page.documents!.map((d) => d.id));
          expect(page.documents![0]).not.toHaveProperty("cursor_value");
          pageToken = page.nextCursor ?? undefined;
          expect(ids.length).toBeLessThanOrEqual(4);
        } while (pageToken);
        expect(ids).toEqual(
          direction === "asc" ? ["a", "b", "c", "d"] : ["d", "c", "b", "a"],
        );
      }
    },
  );
  test("deleted cursor anchor and new documents before the cursor do not disturb traversal", async () => {
    const sort = { sort: order("createdAt", "desc") };
    const first = await call("GET", ["posts"], { ...sort, size: 2 });
    await call("DELETE", ["posts", "c"]);
    await call("PUT", ["posts", "new"], { body: { data: true } });
    const next = await call("GET", ["posts"], {
      ...sort,
      after: first.nextCursor,
      size: 10,
    });
    expect(next.documents!.map((d) => d.id)).toEqual(["b", "a"]);
    expect(next.nextCursor).toBeNull();
  });
  test("includeTotal counts the filtered result without changing the page", async () => {
    const page = await call("GET", ["posts"], {
      size: 2,
      includeTotal: true,
      adminUserId: undefined,
    });
    expect(page.documents).toHaveLength(2);
    expect(page.nextCursor).toEqual(expect.any(String));
    expect(page.totalCount).toBe(4);
  });
  test("cursors reject mismatched order, collection, recreation and malformed input", async () => {
    const first = await call("GET", ["posts"], {
      sort: order("createdAt", "desc"),
      size: 1,
    });
    await call("POST", [], { body: { name: "other", read: "world" } });
    for (const extra of [
      { sort: order("updatedAt", "desc") },
      { sort: order("createdAt", "asc") },
      {},
    ])
      await expect(
        call("GET", ["posts"], { ...extra, after: first.nextCursor }),
      ).rejects.toMatchObject({ status: 400 });
    await expect(
      call("GET", ["other"], {
        sort: order("createdAt", "desc"),
        after: first.nextCursor,
      }),
    ).rejects.toMatchObject({ status: 400 });
    for (const after of ["", "v1.bad", "x".repeat(2000), "a"])
      await expect(
        call("GET", ["posts"], {
          sort: order("createdAt"),
          after: after,
        }),
      ).rejects.toMatchObject({ status: 400 });
    await call("DELETE", ["posts"]);
    await call("POST", [], { body: { name: "posts" } });
    await expect(
      call("GET", ["posts"], {
        sort: order("createdAt", "desc"),
        after: first.nextCursor,
      }),
    ).rejects.toMatchObject({ status: 400 });
  });
  test("sort inputs are allowlisted and raw ID page tokens are rejected", async () => {
    for (const extra of [
      { sort: order("data.") },
      { sort: order("data.nested.title") },
      { sort: order("data.title; drop table users") },
      { sort: order("data title") },
      { sort: order("id; drop table users") },
      { sort: order("createdAt", "sideways") },
      { sort: "" },
      // The one wire form is the JSON array; a bare field name is refused.
      { sort: "createdAt" },
      { sort: "[]" },
      // User fields are bare names; the old data.-prefixed form is refused.
      { sort: JSON.stringify([["data.title", "asc"]]) },
      { sort: JSON.stringify([[{ metadata: "version" }, "asc"]]) },
      { sort: JSON.stringify([[{ metadata: "id", field: "x" }, "asc"]]) },
      { sort: JSON.stringify([[null, "asc"]]) },
      {
        sort: JSON.stringify([
          [{ metadata: "id" }, "asc"],
          [{ metadata: "createdAt" }, "asc"],
        ]),
      },
      {
        sort: JSON.stringify([
          [{ metadata: "createdAt" }, "asc"],
          [{ metadata: "createdAt" }, "desc"],
        ]),
      },
    ])
      await expect(call("GET", ["posts"], extra)).rejects.toMatchObject({
        status: 400,
      });
    await expect(call("GET", ["posts"], { after: "b" })).rejects.toMatchObject({
      status: 400,
    });
  });
  test("replacement preserves server creation time, updates modification time, and rules still apply", async () => {
    await call("PUT", ["posts", "a"], {
      body: { data: { created_at: "2099-01-01" } },
    });
    const doc = (await call("GET", ["posts", "a"])).document!;
    expect(new Date(doc.createdAt).toISOString()).toBe(
      "2026-08-01T00:00:00.000Z",
    );
    expect(new Date(doc.updatedAt).getTime()).toBeGreaterThan(
      new Date(doc.createdAt).getTime(),
    );
    expect(
      (
        await call("GET", ["posts"], {
          sort: order("updatedAt", "desc"),
          size: 1,
        })
      ).documents![0].id,
    ).toBe("a");
    const page = await call("GET", ["posts"], {
      sort: order("createdAt"),
      size: 1,
    });
    await call("PATCH", ["posts"], { body: { read: "admin", write: "admin" } });
    await expect(
      call("GET", ["posts"], {
        sort: order("createdAt"),
        after: page.nextCursor,
        adminUserId: undefined,
      }),
    ).rejects.toMatchObject({ status: 403 });
  });
  test("document field ordering stays total across missing fields, ties and value types", async () => {
    await call("POST", [], { body: { name: "notes", read: "world" } });
    for (const [id, data] of [
      ["missing", { title: "z" }],
      ["null", { date: null }],
      ["early", { date: "2026-01-01" }],
      ["tieA", { date: "2026-06-01" }],
      ["tieB", { date: "2026-06-01" }],
      ["late", { date: "2026-12-31" }],
      ["numeric", { date: 20260101 }],
    ] as const)
      await call("PUT", ["notes", id], { body: { data } });
    // JSONB sorts null below strings below numbers; an absent field sorts with
    // null and IDs break ties, so every document has one stable position.
    const ascending = [
      "missing",
      "null",
      "early",
      "tieA",
      "tieB",
      "late",
      "numeric",
    ];
    for (const direction of ["asc", "desc"]) {
      const ids: string[] = [];
      let pageToken: string | undefined;
      do {
        const page = await call("GET", ["notes"], {
          sort: order("data.date", direction),
          size: 2,
          after: pageToken,
          adminUserId: undefined,
        });
        ids.push(...page.documents!.map((d) => d.id));
        expect(page.documents![0]).not.toHaveProperty("cursor_value");
        pageToken = page.nextCursor ?? undefined;
        expect(ids.length).toBeLessThanOrEqual(ascending.length);
      } while (pageToken);
      expect(ids).toEqual(
        direction === "asc" ? ascending : [...ascending].reverse(),
      );
    }
  });
  test("field cursors are bound to the ordering field", async () => {
    await call("POST", [], { body: { name: "notes", read: "world" } });
    for (const id of ["one", "two"])
      await call("PUT", ["notes", id], {
        body: { data: { date: id, title: id } },
      });
    const first = await call("GET", ["notes"], {
      sort: order("data.date"),
      size: 1,
    });
    expect(first.nextCursor).toEqual(expect.any(String));
    for (const orderBy of ["data.title", "createdAt", "id"])
      await expect(
        call("GET", ["notes"], {
          sort: order(orderBy),
          after: first.nextCursor,
        }),
      ).rejects.toMatchObject({ status: 400 });
    expect(
      (
        await call("GET", ["notes"], {
          sort: order("data.date"),
          after: first.nextCursor,
        })
      ).documents!.map((d) => d.id),
    ).toEqual(["two"]);
  });
  test("scalar ordering and cursors use explicit code-point order and type groups", async () => {
    await call("POST", [], { body: { name: "scalars", read: "world" } });
    const entries = [
      ["A-missing", {}],
      ["B-null", { key: null }],
      ["C-array", { key: [] }],
      ["D-object", { key: {} }],
      ["upper", { key: "Z" }],
      ["lower", { key: "a" }],
      ["accent", { key: "é" }],
      ["korean", { key: "가" }],
      ["negative", { key: -2 }],
      ["ten", { key: 10 }],
      ["false", { key: false }],
      ["true", { key: true }],
    ] as const;
    for (const [id, data] of entries)
      await call("PUT", ["scalars", id], { body: { data } });
    for (const direction of ["asc", "desc"]) {
      for (const sort of [
        order("data.key", direction),
        JSON.stringify([
          ["key", direction],
          [{ metadata: "createdAt" }, "asc"],
        ]),
      ]) {
        // Single-key order has ID ties. Multi-key ties use creation time (insert order here).
        const ids: string[] = [];
        let after: string | undefined;
        do {
          const page = await call("GET", ["scalars"], { sort, size: 1, after });
          ids.push(...page.documents!.map((doc) => doc.id));
          after = page.nextCursor ?? undefined;
          expect(ids.length).toBeLessThanOrEqual(entries.length);
        } while (after);
        const expected = entries.map(([id]) => id);
        if (direction === "desc") {
          expected.reverse();
          if (JSON.parse(sort).length === 2)
            expected.splice(8, 4, "A-missing", "B-null", "C-array", "D-object");
        }
        expect(ids).toEqual(expected);
      }
    }
    const ranged = await call("GET", ["scalars"], {
      filter: { key: { gte: "Z", lt: "é" } },
      sort: order("data.key"),
    });
    expect(ranged.documents!.map((doc) => doc.id)).toEqual(["upper", "lower"]);
  });

  test("metadata ordering still reaches its index after the sort rewrite", async () => {
    const plan = await db.transaction().execute(async (tx) => {
      await sql`set local enable_seqscan=off`.execute(tx);
      return sql`explain (format json) select id from site_data_documents
        where collection_id = 1 order by "created_at" desc, id collate "C" desc limit 2`.execute(
        tx,
      );
    });
    expect(JSON.stringify(plan.rows)).toContain(
      "site_data_documents_created_at_idx",
    );
    expect(JSON.stringify(plan.rows)).not.toContain('"Node Type":"Sort"');
  });

  test("two-field ordering remains global across page tokens", async () => {
    await call("PUT", ["posts", "a"], {
      body: { data: { title: "a", day: "2026-09-01" } },
    });
    await call("PUT", ["posts", "b"], {
      body: { data: { title: "b", day: "2026-09-01" } },
    });
    await call("PUT", ["posts", "c"], {
      body: { data: { title: "c", day: "2026-09-02" } },
    });
    await sql`update site_data_documents set created_at='2026-09-01T01:00:00Z' where id='a'`.execute(
      db,
    );
    await sql`update site_data_documents set created_at='2026-09-01T03:00:00Z' where id='b'`.execute(
      db,
    );
    await sql`update site_data_documents set created_at='2026-09-01T02:00:00Z' where id='c'`.execute(
      db,
    );
    const orderBy = JSON.stringify([
      ["day", "desc"],
      [{ metadata: "createdAt" }, "desc"],
    ]);
    const ids: string[] = [];
    let pageToken: string | undefined;
    do {
      const page = await call("GET", ["posts"], {
        sort: orderBy,
        after: pageToken,
        size: 1,
        adminUserId: undefined,
      });
      ids.push(page.documents![0].id);
      pageToken = page.nextCursor ?? undefined;
    } while (pageToken);
    expect(ids.slice(0, 3)).toEqual(["c", "b", "a"]);
  });
  test("migration backfills creation time without changing data and supports rollback", async () => {
    await down(db);
    await up(db);
    const result = await sql<{
      equal: boolean;
      count: string;
    }>`select bool_and(created_at=updated_at) as equal, count(*) as count from site_data_documents`.execute(
      db,
    );
    expect(result.rows[0]).toEqual({ equal: true, count: "4" });
    expect((await call("GET", ["posts", "a"])).document!.data).toEqual({
      title: "a",
    });
  });
});
