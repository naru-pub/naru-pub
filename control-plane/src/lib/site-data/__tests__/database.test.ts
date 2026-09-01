/** @jest-environment node */
import { describe, test, expect, beforeAll, afterAll } from "@jest/globals";
import { sql } from "kysely";
import { db } from "@/lib/database";
import { executeBatch, executeData } from "../service";
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
  test("merge patches change named fields only and leave the rest untouched", async () => {
    await call("POST", [], { name: "notes", read: "world" }, true);
    const created = await call(
      "PUT",
      ["notes", "one"],
      { data: { title: "first", body: "text", legacy: "drop", keep: [1, 2] } },
      true,
    );
    expect(created).toEqual({ id: "one", version: 1 });
    const patched = await call(
      "PATCH",
      ["notes", "one"],
      { data: { title: "second", added: null }, unset: ["legacy"] },
      true,
    );
    expect(patched).toEqual({ id: "one", version: 2 });
    const document = (await call("GET", ["notes", "one"])).document!;
    // A null in the patch stores null; removal is only ever explicit.
    expect(document.data).toEqual({
      title: "second",
      body: "text",
      added: null,
      keep: [1, 2],
    });
    expect(document.version).toBe(2);
    // Size accounting follows the merged document, not the patch.
    const stored = await sql<{
      size_bytes: number;
    }>`select d.size_bytes from site_data_documents d
      join site_data_collections c on c.id = d.collection_id
      where c.name = 'notes' and d.id = 'one'`.execute(db);
    expect(stored.rows[0].size_bytes).toBe(
      Buffer.byteLength(JSON.stringify(document.data)),
    );
    await expect(
      call("PATCH", ["notes", "missing"], { data: { a: 1 } }, true),
    ).rejects.toMatchObject({ status: 404 });
    await call("PUT", ["notes", "scalar"], { data: "text" }, true);
    await expect(
      call("PATCH", ["notes", "scalar"], { data: { a: 1 } }, true),
    ).rejects.toMatchObject({ status: 409, code: "NOT_MERGEABLE" });
    for (const body of [
      { data: "text" },
      { data: [1] },
      { data: null },
      { data: { a: 1 }, unset: "legacy" },
      { data: { a: 1 }, unset: [1] },
    ])
      await expect(
        call("PATCH", ["notes", "one"], body, true),
      ).rejects.toMatchObject({ status: 400 });
    await expect(call("PATCH", ["notes", "one"], { data: { a: 1 } })).rejects.toMatchObject({
      status: 403,
    });
  });
  test("conditional writes reject stale versions and guard creation", async () => {
    await call("POST", [], { name: "guarded", read: "world" }, true);
    const created = await call(
      "PUT",
      ["guarded", "one"],
      { data: { round: 1 } },
      true,
      { ifVersion: 0 },
    );
    expect(created.version).toBe(1);
    // ifVersion 0 asserts absence, so it cannot clobber an existing document.
    await expect(
      call("PUT", ["guarded", "one"], { data: { round: 2 } }, true, {
        ifVersion: 0,
      }),
    ).rejects.toMatchObject({ status: 409, code: "VERSION_CONFLICT" });
    expect(
      (
        await call("PUT", ["guarded", "one"], { data: { round: 2 } }, true, {
          ifVersion: 1,
        })
      ).version,
    ).toBe(2);
    // The losing writer of a concurrent edit is told rather than overwriting.
    await expect(
      call("PATCH", ["guarded", "one"], { data: { round: 3 } }, true, {
        ifVersion: 1,
      }),
    ).rejects.toMatchObject({ status: 409, code: "VERSION_CONFLICT" });
    await expect(
      call("DELETE", ["guarded", "one"], undefined, true, { ifVersion: 1 }),
    ).rejects.toMatchObject({ status: 409, code: "VERSION_CONFLICT" });
    expect((await call("GET", ["guarded", "one"])).document!.data).toEqual({
      round: 2,
    });
    for (const ifVersion of [-1, 1.5, NaN, "2"])
      await expect(
        call("PUT", ["guarded", "one"], { data: {} }, true, { ifVersion }),
      ).rejects.toMatchObject({ status: 400 });
    await call("DELETE", ["guarded", "one"], undefined, true, { ifVersion: 2 });
    await expect(call("GET", ["guarded", "one"])).rejects.toMatchObject({
      status: 404,
    });
  });
  test("batch applies merges and conditional writes atomically", async () => {
    const batch = (...operations: Record<string, unknown>[]) =>
      executeBatch({
        site: "alice",
        path: [],
        method: "POST",
        adminUserId: owner,
        body: { operations },
      });
    await call("POST", [], { name: "batched", read: "world" }, true);
    await call(
      "PUT",
      ["batched", "one"],
      { data: { title: "a", keep: true } },
      true,
    );
    const applied = await batch(
      {
        type: "update",
        collection: "batched",
        id: "one",
        data: { title: "b" },
        unset: ["keep"],
      },
      { type: "set", collection: "batched", id: "two", data: { title: "c" } },
    );
    expect(applied.results).toEqual([
      { id: "one", version: 2 },
      { id: "two", version: 1 },
    ]);
    expect((await call("GET", ["batched", "one"])).document!.data).toEqual({
      title: "b",
    });
    // One stale operation rolls the whole batch back, including earlier writes.
    await expect(
      batch(
        {
          type: "set",
          collection: "batched",
          id: "three",
          data: { title: "d" },
        },
        {
          type: "update",
          collection: "batched",
          id: "one",
          data: { title: "e" },
          ifVersion: 1,
        },
      ),
    ).rejects.toMatchObject({ status: 409, code: "VERSION_CONFLICT" });
    await expect(call("GET", ["batched", "three"])).rejects.toMatchObject({
      status: 404,
    });
    expect((await call("GET", ["batched", "one"])).document!.data).toEqual({
      title: "b",
    });
    await expect(
      batch({
        type: "update",
        collection: "batched",
        id: "missing",
        data: { title: "f" },
      }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      batch({ type: "replace", collection: "batched", id: "one", data: {} }),
    ).rejects.toMatchObject({ status: 400 });
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
