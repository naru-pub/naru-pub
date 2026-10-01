/** @jest-environment node */
import { describe, test, expect, beforeAll, afterAll } from "@jest/globals";
import { sql } from "kysely";
import { db } from "@/lib/database";
import { executeBatch, executeData } from "../service";
import { jsonBody, MAX_DOCUMENT_BYTES } from "../validation";
import { setupTestDatabase, teardownTestDatabase } from "./test-database";

/** Every accepted write reports its version and the stamps it produced. */
// Opt in against a dedicated disposable database, never the developer's app DB.
const integration =
  process.env.NARU_DATA_TEST === "1" ? describe : describe.skip;
integration("site database integration", () => {
  let initialized = false;
  let owner: string;
  let other: string;
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
        id: string;
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
    // The protocol's own paths would shadow these.
    for (const name of ["_batch", "_files", "_later"])
      await expect(call("POST", [], { name }, true)).rejects.toMatchObject({
        status: 400,
      });
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
  test("rejects sites whose owner is not a supporter", async () => {
    const denied = (
      await sql<{
        id: string;
      }>`insert into users(login_name, supporter_comp) values ('not-enabled', false) returning id`.execute(
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
  test("allows sites whose owner has paid", async () => {
    const paid = (
      await sql<{
        id: string;
      }>`insert into users(login_name, supporter_comp, supporter_until)
        values ('paid', false, now() + interval '30 days') returning id`.execute(
        db,
      )
    ).rows[0].id;
    await expect(
      executeData({
        site: "paid",
        path: [],
        method: "GET",
        adminUserId: paid,
      }),
    ).resolves.toBeDefined();
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
  test("create-only visitors receive their own stored document without gaining read access", async () => {
    await call(
      "POST",
      [],
      { name: "inquiries", read: "admin", write: "create" },
      true,
    );
    const result = await call("POST", ["inquiries"], {
      data: { message: "Hello" },
    });
    expect(result).toMatchObject({
      id: expect.any(String),
      data: { message: "Hello" },
      version: 1,
    });
    await expect(call("GET", ["inquiries", result.id!])).rejects.toMatchObject({
      status: 403,
    });
  });
  test("tenant isolation, pagination, replacement and cascade", async () => {
    other = (
      await sql<{
        id: string;
      }>`insert into users(login_name) values ('bob') returning id`.execute(db)
    ).rows[0].id;
    await expect(
      call("GET", ["private"], undefined, true, { adminUserId: other }),
    ).rejects.toMatchObject({ status: 403 });
    await call("POST", [], { name: "pages", read: "world" }, true);
    for (const id of ["a", "b", "c"])
      await call("PUT", ["pages", id], { data: { id, old: true } }, true);
    const first = await call("GET", ["pages"], undefined, false, { size: 2 });
    expect(first).toMatchObject({
      documents: [{ id: "a" }, { id: "b" }],
      nextCursor: expect.stringMatching(/^v1\./),
    });
    expect(
      await call("GET", ["pages"], undefined, false, {
        size: 2,
        after: first.nextCursor,
      }),
    ).toMatchObject({ documents: [{ id: "c" }], nextCursor: null });
    await call("PUT", ["pages", "a"], { data: { replacement: true } }, true);
    expect(await call("GET", ["pages", "a"])).toMatchObject({
      document: { data: { replacement: true } },
    });
    await expect(
      call("GET", ["pages"], undefined, false, { size: 101 }),
    ).rejects.toMatchObject({ status: 400 });
    await call("DELETE", ["pages"], undefined, true);
    await expect(call("GET", ["pages", "a"])).rejects.toMatchObject({
      status: 404,
    });
  });
  test("documents cannot be patched: replacement is the only update", async () => {
    await call("POST", [], { name: "notes", read: "world" }, true);
    await call("PUT", ["notes", "one"], { data: { title: "first" } }, true);
    await expect(
      call("PATCH", ["notes", "one"], { data: { title: "second" } }, true),
    ).rejects.toMatchObject({ status: 405 });
    expect((await call("GET", ["notes", "one"])).document!.data).toEqual({
      title: "first",
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
    ).rejects.toMatchObject({ status: 409, code: "CONFLICT" });
    expect(
      (
        await call("PUT", ["guarded", "one"], { data: { round: 2 } }, true, {
          ifVersion: 1,
        })
      ).version,
    ).toBe(2);
    // The losing writer of a concurrent edit is told rather than overwriting.
    await expect(
      call("PUT", ["guarded", "one"], { data: { round: 3 } }, true, {
        ifVersion: 1,
      }),
    ).rejects.toMatchObject({ status: 409, code: "CONFLICT" });
    await expect(
      call("DELETE", ["guarded", "one"], undefined, true, { ifVersion: 1 }),
    ).rejects.toMatchObject({ status: 409, code: "CONFLICT" });
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
  test("refusals name what was refused and where it is fixed", async () => {
    await expect(call("GET", ["nowhere"])).rejects.toMatchObject({
      status: 404,
      message: expect.stringMatching(/nowhere does not exist.*control panel/),
    });
    await expect(
      executeData({ site: "nobody", path: ["posts"], method: "GET" }),
    ).rejects.toMatchObject({ message: "No Naru site is named nobody." });
    await call("POST", [], { name: "secret" }, true);
    await expect(call("GET", ["secret"])).rejects.toMatchObject({
      status: 403,
      message: expect.stringContaining("secret is not publicly readable"),
    });
    await expect(call("POST", ["secret"], { data: 1 })).rejects.toMatchObject({
      message: expect.stringContaining(
        "Visitors cannot add to collection secret",
      ),
    });
    await call("PUT", ["secret", "one"], { data: 1 }, true);
    await expect(
      call("PUT", ["secret", "one"], { data: 2 }, true, { ifVersion: 0 }),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      message: "The document already exists.",
    });
    await expect(
      call("PUT", ["secret", "one"], { data: 2 }, true, { ifVersion: 7 }),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      message: expect.stringContaining("changed after that revision"),
    });
  });
  test("batch applies conditional writes atomically", async () => {
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
        type: "set",
        collection: "batched",
        id: "one",
        data: { title: "b" },
        ifVersion: 1,
      },
      { type: "set", collection: "batched", id: "two", data: { title: "c" } },
      { type: "delete", collection: "batched", id: "gone" },
    );
    // In order: each set's new version and stamps, never its data; a delete
    // reports null.
    expect(applied).toEqual({
      success: true,
      results: [
        {
          id: "one",
          version: 2,
          createdAt: expect.any(Date),
          updatedAt: expect.any(Date),
        },
        {
          id: "two",
          version: 1,
          createdAt: expect.any(Date),
          updatedAt: expect.any(Date),
        },
        null,
      ],
    });
    expect((await call("GET", ["batched", "one"])).document!.version).toBe(2);
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
          type: "set",
          collection: "batched",
          id: "one",
          data: { title: "e" },
          ifVersion: 1,
        },
      ),
    ).rejects.toMatchObject({ status: 409, code: "CONFLICT" });
    await expect(call("GET", ["batched", "three"])).rejects.toMatchObject({
      status: 404,
    });
    expect((await call("GET", ["batched", "one"])).document!.data).toEqual({
      title: "b",
    });
    for (const type of ["update", "replace"])
      await expect(
        batch({ type, collection: "batched", id: "one", data: {} }),
      ).rejects.toMatchObject({ status: 400 });
    // Creating with a server-assigned id is add(), outside transactions.
    for (const operation of [
      { type: "add", collection: "batched", data: {} },
      { type: "add", collection: "batched", id: "one", data: {} },
      { type: "set", collection: "batched", data: {} },
    ])
      await expect(batch(operation)).rejects.toMatchObject({ status: 400 });
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
      reason: { status: 409, code: "QUOTA_EXCEEDED" },
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
  test("a public write over its limit is refused without waiting for the site lock", async () => {
    await sql`delete from site_data_rate_limits`.execute(db);
    await call("POST", [], { name: "burst", write: "create" }, true);
    await call("POST", ["burst"], { data: 1 }, false, {
      clientIp: "192.0.2.9",
    });
    await sql`update site_data_rate_limits set count = 20 where key <> 'site'`.execute(
      db,
    );
    // Hold the owner row the way a slow legitimate write would.
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const holder = db.transaction().execute(async (tx) => {
      await sql`select id from users where id = ${owner} for update`.execute(
        tx,
      );
      await held;
    });
    try {
      const refused = call("POST", ["burst"], { data: 2 }, false, {
        clientIp: "192.0.2.9",
      });
      const outcome = await Promise.race([
        refused.then(
          () => "allowed",
          (error) => error.status,
        ),
        new Promise((resolve) => setTimeout(() => resolve("waited"), 1000)),
      ]);
      expect(outcome).toBe(429);
      // The owner is never turned away early, and still waits its turn.
      const ownerWrite = call("POST", ["burst"], { data: 3 }, true);
      const ownerOutcome = await Promise.race([
        ownerWrite.then(() => "written"),
        new Promise((resolve) => setTimeout(() => resolve("waited"), 300)),
      ]);
      expect(ownerOutcome).toBe("waited");
      release();
      await expect(ownerWrite).resolves.toBeDefined();
    } finally {
      release();
      await holder;
      await sql`delete from site_data_rate_limits`.execute(db);
    }
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
      reason: { status: 409, code: "QUOTA_EXCEEDED" },
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
