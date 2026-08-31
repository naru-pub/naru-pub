/** @jest-environment node */
import { describe, test, expect, beforeAll, afterAll } from "@jest/globals";
import { sql } from "kysely";
import { db } from "@/lib/database";
import { executeData } from "../service";
import { jsonBody, MAX_DOCUMENT_BYTES } from "../validation";
import { up, down } from "@/migrations/1788176027971_add_site_database";

// Opt in against a dedicated disposable database, never the developer's app DB.
const integration =
  process.env.NARU_DATA_TEST === "1" ? describe : describe.skip;
integration("site database integration", () => {
  let initialized = false;
  let owner: number;
  let other: number;
  const call = (
    method: string,
    path: string[],
    body?: Record<string, unknown>,
    admin = false,
    extra = {},
  ) =>
    executeData({
      site: "alice",
      path,
      method,
      body,
      adminUserId: admin ? owner : undefined,
      ...extra,
    });
  beforeAll(async () => {
    if (new URL(process.env.DATABASE_URL!).pathname !== "/naru_data_test")
      throw new Error("Use a disposable naru_data_test database.");
    await db.schema
      .createTable("users")
      .addColumn("id", "serial", (c) => c.primaryKey())
      .addColumn("login_name", "text", (c) => c.notNull().unique())
      .execute();
    await up(db);
    initialized = true;
    owner = (
      await sql<{
        id: number;
      }>`insert into users(login_name) values ('alice') returning id`.execute(
        db,
      )
    ).rows[0].id;
  });
  afterAll(async () => {
    if (initialized) {
      await down(db);
      await db.schema.dropTable("users").execute();
    }
    await db.destroy();
  });
  test("owner-only collection management and private defaults", async () => {
    await expect(call("POST", [], { name: "private" })).rejects.toMatchObject({
      status: 403,
    });
    await call("POST", [], { name: "private" }, true);
    await expect(
      call("POST", [], { name: "private" }, true),
    ).rejects.toMatchObject({ status: 409 });
    await expect(call("GET", ["private"])).rejects.toMatchObject({
      status: 403,
    });
    await expect(
      call("POST", ["private"], { data: "secret" }),
    ).rejects.toMatchObject({ status: 403 });
    await call("PUT", ["private", "one"], { data: null }, true);
    expect(
      await call("GET", ["private", "one"], undefined, true),
    ).toMatchObject({ document: { data: null } });
  });
  test.each([
    ["world", "world"],
    ["world", "admin"],
    ["admin", "world"],
    ["admin", "admin"],
  ])("read=%s write=%s", async (read, write) => {
    const collection = `${read}_${write}`;
    await call("POST", [], { name: collection, read, write }, true);
    await call("PUT", [collection, "one"], { data: { secret: true } }, true);
    for (const path of [[collection], [collection, "one"]]) {
      if (read === "world")
        await expect(call("GET", path)).resolves.toBeDefined();
      else
        await expect(call("GET", path)).rejects.toMatchObject({ status: 403 });
    }
    for (const [method, path, body] of [
      ["POST", [collection], { data: [1, "two"] }],
      ["PUT", [collection, "one"], { data: false }],
      ["DELETE", [collection, "one"], undefined],
    ] as const) {
      const request = call(method, [...path], body);
      if (write === "world") await expect(request).resolves.toBeDefined();
      else await expect(request).rejects.toMatchObject({ status: 403 });
    }
    await expect(
      call("PATCH", [collection], { read: "world", write: "world" }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(call("DELETE", [collection])).rejects.toMatchObject({
      status: 403,
    });
  });
  test("tenant isolation, pagination, replacement and cascade", async () => {
    other = (
      await sql<{
        id: number;
      }>`insert into users(login_name) values ('bob') returning id`.execute(db)
    ).rows[0].id;
    await expect(
      call("GET", ["private"], undefined, true, { adminUserId: other }),
    ).rejects.toMatchObject({ status: 403 });
    await call("POST", [], { name: "pages", read: "world" }, true);
    for (const id of ["a", "b", "c"])
      await call("PUT", ["pages", id], { data: { id, old: true } }, true);
    const first = await call("GET", ["pages"], undefined, false, { limit: 2 });
    expect(first).toMatchObject({
      documents: [{ id: "a" }, { id: "b" }],
      nextCursor: "b",
    });
    expect(
      await call("GET", ["pages"], undefined, false, { limit: 2, after: "b" }),
    ).toMatchObject({ documents: [{ id: "c" }], nextCursor: null });
    await call("PUT", ["pages", "a"], { data: { replacement: true } }, true);
    expect(await call("GET", ["pages", "a"])).toMatchObject({
      document: { data: { replacement: true } },
    });
    await expect(
      call("GET", ["pages"], undefined, false, { limit: 101 }),
    ).rejects.toMatchObject({ status: 400 });
    await call("DELETE", ["pages"], undefined, true);
    await expect(call("GET", ["pages", "a"])).rejects.toMatchObject({
      status: 404,
    });
  });
  test("rule revocation takes effect on the next request", async () => {
    await call(
      "POST",
      [],
      { name: "revoked", read: "world", write: "world" },
      true,
    );
    await call("PUT", ["revoked", "one"], { data: true });
    await call("PATCH", ["revoked"], { read: "admin", write: "admin" }, true);
    await expect(call("GET", ["revoked", "one"])).rejects.toMatchObject({
      status: 403,
    });
    await expect(call("DELETE", ["revoked", "one"])).rejects.toMatchObject({
      status: 403,
    });
    await expect(
      call("PATCH", ["revoked"], { read: "invalid", write: "world" }, true),
    ).rejects.toMatchObject({ status: 400 });
  });
  test("concurrent writes cannot exceed byte quota, replacement frees space", async () => {
    await sql`delete from site_data_collections`.execute(db);
    await call("POST", [], { name: "bytes", write: "world" }, true);
    await sql`insert into site_data_documents(collection_id,id,data,size_bytes)
      select c.id, 'seed' || n, to_jsonb(repeat('x', 65500)), 65502
      from site_data_collections c cross join generate_series(1,160) n`.execute(
      db,
    );
    const results = await Promise.allSettled([
      call("PUT", ["bytes", "a"], { data: "x".repeat(4000) }),
      call("PUT", ["bytes", "b"], { data: "x".repeat(4000) }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.find((r) => r.status === "rejected")).toMatchObject({
      reason: { status: 409 },
    });
    await call("PUT", ["bytes", "seed1"], { data: null });
    await expect(
      call("PUT", ["bytes", "c"], { data: "x".repeat(4000) }),
    ).resolves.toBeDefined();
  });
  test("concurrent writes cannot exceed document quota", async () => {
    await sql`delete from site_data_collections`.execute(db);
    await call("POST", [], { name: "quota", write: "world" }, true);
    await sql`insert into site_data_documents(collection_id,id,data,size_bytes)
      select c.id, 'seed' || n, '{}'::jsonb, 2 from site_data_collections c cross join generate_series(1,9999) n`.execute(
      db,
    );
    const results = await Promise.allSettled([
      call("POST", ["quota"], { data: 1 }),
      call("POST", ["quota"], { data: 2 }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.find((r) => r.status === "rejected")).toMatchObject({
      reason: { status: 409 },
    });
    await call("DELETE", ["quota", "seed1"]);
    await expect(call("POST", ["quota"], { data: 3 })).resolves.toBeDefined();
    await db.deleteFrom("users").where("id", "=", owner).execute();
    expect(
      await db.selectFrom("site_data_documents").selectAll().execute(),
    ).toEqual([]);
  });
});

describe("request validation", () => {
  test("rejects oversized bodies without Content-Length", async () => {
    const request = new Request("http://localhost", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ data: "x".repeat(MAX_DOCUMENT_BYTES) }),
    });
    await expect(jsonBody(request)).rejects.toMatchObject({ status: 413 });
  });
  test.each(["[]", "null", "{"])(
    "rejects malformed envelope %s",
    async (body) => {
      await expect(
        jsonBody(
          new Request("http://localhost", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body,
          }),
        ),
      ).rejects.toMatchObject({ status: 400 });
    },
  );
});
