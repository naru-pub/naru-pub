/** @jest-environment node */
import { describe, test, expect, beforeAll, afterAll } from "@jest/globals";
import { sql } from "kysely";
import { db } from "@/lib/database";
import { executeData } from "../service";
import { jsonBody, MAX_DOCUMENT_BYTES } from "../validation";
import { setupTestDatabase, teardownTestDatabase } from "./test-database";

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
    await setupTestDatabase();
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
      await teardownTestDatabase();
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
  test("preview gate rejects sites outside the configured allowlist", async () => {
    const denied = (
      await sql<{ id: number }>`insert into users(login_name, supporter_comp) values ('not-enabled', false) returning id`.execute(
        db,
      )
    ).rows[0].id;
    await expect(
      executeData({
        site: "not-enabled",
        path: [],
        method: "GET",
        adminUserId: denied,
      }),
    ).rejects.toMatchObject({
      status: 403,
      message: "Database access is not enabled for this site.",
    });
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
      nextCursor: expect.stringMatching(/^v1\./),
    });
    expect(
      await call("GET", ["pages"], undefined, false, {
        limit: 2,
        after: first.nextCursor,
      }),
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
  test("create-only allows server IDs but denies replacement, custom IDs and deletion", async () => {
    await call(
      "POST",
      [],
      { name: "comments", read: "world", write: "create" },
      true,
    );
    const result = await call("POST", ["comments"], {
      data: { message: "hi" },
      id: "chosen",
    });
    expect(result.id).not.toBe("chosen");
    expect(result.id).toMatch(/^[a-f0-9-]{36}$/);
    await expect(call("GET", ["comments", result.id!])).resolves.toMatchObject({
      document: { data: { message: "hi" } },
    });
    for (const id of [result.id!, "unused"]) {
      await expect(
        call("PUT", ["comments", id], { data: "overwrite" }),
      ).rejects.toMatchObject({ status: 403 });
      await expect(call("DELETE", ["comments", id])).rejects.toMatchObject({
        status: 403,
      });
    }
    await call("PUT", ["comments", result.id!], { data: "moderated" }, true);
    await call("DELETE", ["comments", result.id!], undefined, true);
    await call("PATCH", ["comments"], { read: "admin", write: "create" }, true);
    const privateResult = await call("POST", ["comments"], { data: "private" });
    await expect(
      call("GET", ["comments", privateResult.id!]),
    ).rejects.toMatchObject({ status: 403 });
  });
  test("public creation rate limits are shared across workers and do not limit owners", async () => {
    await sql`delete from site_data_rate_limits`.execute(db);
    await call("POST", [], { name: "limited", write: "create" }, true);
    const outcomes = await Promise.allSettled(
      Array.from({ length: 21 }, () =>
        call("POST", ["limited"], { data: 1 }, false, {
          clientIp: "192.0.2.1",
        }),
      ),
    );
    expect(outcomes.filter((r) => r.status === "fulfilled")).toHaveLength(20);
    expect(outcomes.find((r) => r.status === "rejected")).toMatchObject({
      reason: { status: 429 },
    });
    await expect(
      call("POST", ["limited"], { data: 1 }, true),
    ).resolves.toBeDefined();
    await expect(
      call("POST", ["limited"], { data: 1 }, false, { clientIp: "192.0.2.2" }),
    ).resolves.toBeDefined();
    await sql`update site_data_rate_limits set count = 60 where key = 'site'`.execute(
      db,
    );
    await expect(
      call("POST", ["limited"], { data: 1 }, false, { clientIp: "192.0.2.3" }),
    ).rejects.toMatchObject({ status: 429 });
    await sql`update site_data_rate_limits set window_start = now() - interval '2 minutes'`.execute(
      db,
    );
    await expect(
      call("POST", ["limited"], { data: 1 }, false, { clientIp: "192.0.2.3" }),
    ).resolves.toBeDefined();
    await sql`delete from site_data_rate_limits`.execute(db);
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
