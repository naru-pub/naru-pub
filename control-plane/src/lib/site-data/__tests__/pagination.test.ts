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

const integration =
  process.env.NARU_DATA_TEST === "1" ? describe : describe.skip;
integration("sorted database pagination", () => {
  let ready = false,
    owner: number;
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
        id: number;
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
  test.each(["id", "created_at", "updated_at"])(
    "%s traversal handles ties and submillisecond precision in both directions",
    async (orderBy) => {
      for (const direction of ["asc", "desc"]) {
        const ids: string[] = [];
        let after: string | undefined;
        do {
          const page = await call("GET", ["posts"], {
            orderBy,
            direction,
            limit: 1,
            after,
            adminUserId: undefined,
          });
          ids.push(...page.documents!.map((d) => d.id));
          expect(page.documents![0]).not.toHaveProperty("cursor_value");
          after = page.nextCursor ?? undefined;
          expect(ids.length).toBeLessThanOrEqual(4);
        } while (after);
        expect(ids).toEqual(
          direction === "asc" ? ["a", "b", "c", "d"] : ["d", "c", "b", "a"],
        );
      }
    },
  );
  test("deleted cursor anchor and new documents before the cursor do not disturb traversal", async () => {
    const sort = { orderBy: "created_at", direction: "desc" };
    const first = await call("GET", ["posts"], { ...sort, limit: 2 });
    await call("DELETE", ["posts", "c"]);
    await call("PUT", ["posts", "new"], { body: { data: true } });
    const next = await call("GET", ["posts"], {
      ...sort,
      after: first.nextCursor,
      limit: 10,
    });
    expect(next.documents!.map((d) => d.id)).toEqual(["b", "a"]);
    expect(next.nextCursor).toBeNull();
  });
  test("cursors reject mismatched order, collection, recreation and malformed input", async () => {
    const first = await call("GET", ["posts"], {
      orderBy: "created_at",
      direction: "desc",
      limit: 1,
    });
    await call("POST", [], { body: { name: "other", read: "world" } });
    for (const extra of [
      { orderBy: "updated_at", direction: "desc" },
      { orderBy: "created_at", direction: "asc" },
      {},
    ])
      await expect(
        call("GET", ["posts"], { ...extra, after: first.nextCursor }),
      ).rejects.toMatchObject({ status: 400 });
    await expect(
      call("GET", ["other"], {
        orderBy: "created_at",
        direction: "desc",
        after: first.nextCursor,
      }),
    ).rejects.toMatchObject({ status: 400 });
    for (const after of ["", "v1.bad", "x".repeat(2000), "a"])
      await expect(
        call("GET", ["posts"], { orderBy: "created_at", after }),
      ).rejects.toMatchObject({ status: 400 });
    await call("DELETE", ["posts"]);
    await call("POST", [], { body: { name: "posts" } });
    await expect(
      call("GET", ["posts"], {
        orderBy: "created_at",
        direction: "desc",
        after: first.nextCursor,
      }),
    ).rejects.toMatchObject({ status: 400 });
  });
  test("sort inputs are allowlisted and legacy ID cursors remain supported", async () => {
    for (const extra of [
      { orderBy: "data.title" },
      { orderBy: "id; drop table users" },
      { direction: "sideways" },
      { orderBy: "" },
      { direction: "" },
    ])
      await expect(call("GET", ["posts"], extra)).rejects.toMatchObject({
        status: 400,
      });
    expect(
      (await call("GET", ["posts"], { after: "b" })).documents!.map(
        (d) => d.id,
      ),
    ).toEqual(["c", "d"]);
  });
  test("replacement preserves server creation time, updates modification time, and rules still apply", async () => {
    await call("PUT", ["posts", "a"], {
      body: { data: { created_at: "2099-01-01" } },
    });
    const doc = (await call("GET", ["posts", "a"])).document!;
    expect(new Date(doc.created_at).toISOString()).toBe(
      "2026-08-01T00:00:00.000Z",
    );
    expect(new Date(doc.updated_at).getTime()).toBeGreaterThan(
      new Date(doc.created_at).getTime(),
    );
    expect(
      (
        await call("GET", ["posts"], {
          orderBy: "updated_at",
          direction: "desc",
          limit: 1,
        })
      ).documents![0].id,
    ).toBe("a");
    const page = await call("GET", ["posts"], {
      orderBy: "created_at",
      limit: 1,
    });
    await call("PATCH", ["posts"], { body: { read: "admin", write: "admin" } });
    await expect(
      call("GET", ["posts"], {
        orderBy: "created_at",
        after: page.nextCursor,
        adminUserId: undefined,
      }),
    ).rejects.toMatchObject({ status: 403 });
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
