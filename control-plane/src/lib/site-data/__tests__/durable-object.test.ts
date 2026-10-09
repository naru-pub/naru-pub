/** @jest-environment node */
import { afterAll, beforeAll, describe, expect, test } from "@jest/globals";
import { sql } from "kysely";
import { db } from "@/lib/database";
import { siteDataBackend } from "../backend";
import { compareSite } from "../compare";
import {
  callSiteDataWorker,
  eraseSiteData,
  executeOnDurableObject,
} from "../durable-object";
import { moveSite, postgresSnapshot, type Snapshot } from "../move";
import {
  approveAuthorization,
  authorizationInput,
  digest,
  exchangeCode,
  prepareAuthorization,
  registerClient,
} from "../owner-auth";
import { executeData, type DataCommand } from "../service";
import { MAX_DOCUMENT_BYTES } from "../validation";
import { setupTestDatabase, teardownTestDatabase } from "./test-database";

// The Durable Objects backend, end to end: PostgreSQL admits each request,
// the site-data Worker (wrangler dev) stores it. scripts/test-data-durable-
// objects.sh starts both. The behaviour expected here is database.test.ts's;
// what PostgreSQL alone decides (paid status, sign-in) is checked through it.
const integration =
  process.env.NARU_DATA_DO_TEST === "1" ? describe : describe.skip;
// Each suite sets up and tears down the schema; the pool outlives them all.
afterAll(() => db.destroy());

const insertUser = async (login: string) =>
  (
    await sql<{
      id: string;
    }>`insert into users(login_name) values (${login}) returning id`.execute(db)
  ).rows[0].id;
const onDurableObject = (login: string) =>
  sql`update users set site_data_backend = 'durable_object' where login_name = ${login}`.execute(
    db,
  );

integration("Durable Objects site database", () => {
  let initialized = false;
  let owner: string;
  const call = async (
    method: string,
    path: string[],
    body?: Record<string, unknown>,
    admin = false,
    extra: Partial<DataCommand> = {},
  ) =>
    (await siteDataBackend("alice")).execute({
      site: "alice",
      path,
      method,
      body,
      adminUserId: admin ? owner : undefined,
      ...extra,
    }) as Promise<Record<string, any>>;
  const batch = async (...operations: Record<string, unknown>[]) =>
    (await siteDataBackend("alice")).batch({
      site: "alice",
      path: [],
      method: "POST",
      adminUserId: owner,
      body: { operations },
    });
  /** Replaces alice's object with these collections and generated documents. */
  const seed = async (
    collections: Snapshot["collections"],
    documents: Snapshot["documents"],
  ) =>
    callSiteDataWorker("alice", "import", {
      ownerId: String(owner),
      collections,
      documents,
    });

  beforeAll(async () => {
    await setupTestDatabase();
    initialized = true;
    owner = await insertUser("alice");
    await onDurableObject("alice");
  });
  afterAll(async () => {
    if (initialized) await teardownTestDatabase();
  });

  test("owner-only collection management and private defaults", async () => {
    await expect(call("POST", [], { name: "private" })).rejects.toMatchObject({
      status: 403,
    });
    const created = await call("POST", [], { name: "private" }, true);
    expect(created.collection).toMatchObject({
      id: expect.stringMatching(/^[0-9a-f-]{36}$/),
      user_id: String(owner),
      name: "private",
      read_access: "admin",
      write_access: "admin",
    });
    await expect(
      call("POST", [], { name: "private" }, true),
    ).rejects.toMatchObject({ status: 409 });
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
    const written = await call("PUT", ["private", "one"], { data: null }, true);
    expect(written).toMatchObject({
      id: "one",
      data: null,
      version: 1,
      createdAt: expect.any(Date),
      updatedAt: expect.any(Date),
    });
    expect(
      await call("GET", ["private", "one"], undefined, true),
    ).toMatchObject({ document: { data: null, version: 1 } });
    expect(await call("GET", [], undefined, true)).toMatchObject({
      collections: [{ name: "private", user_id: String(owner) }],
    });
  });

  test("PostgreSQL still decides who may use the site", async () => {
    await insertUser("not-enabled");
    await sql`update users set supporter_comp = false where login_name = 'not-enabled'`.execute(
      db,
    );
    await onDurableObject("not-enabled");
    await expect(
      (await siteDataBackend("not-enabled")).execute({
        site: "not-enabled",
        path: ["posts"],
        method: "GET",
      }),
    ).rejects.toMatchObject({
      status: 403,
      message: "Database access is not enabled for this site.",
    });
    await expect(
      executeOnDurableObject({
        site: "nobody",
        path: ["posts"],
        method: "GET",
      }),
    ).rejects.toMatchObject({ message: "No Naru site is named nobody." });
    const bob = await insertUser("bob");
    await expect(
      call("GET", ["private"], undefined, false, { adminUserId: bob }),
    ).rejects.toMatchObject({ status: 403, message: "Permission denied." });
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

  test("only anonymous reads of world-readable collections are cacheable", async () => {
    await call("POST", [], { name: "cached", read: "world" }, true);
    const anonymous = { public: false };
    await call("GET", ["cached"], undefined, false, {
      cacheability: anonymous,
    });
    expect(anonymous.public).toBe(true);
    const owned = { public: false };
    await call("GET", ["cached"], undefined, true, { cacheability: owned });
    expect(owned.public).toBe(false);
    const hidden = { public: false };
    await expect(
      call("GET", ["private"], undefined, false, { cacheability: hidden }),
    ).rejects.toMatchObject({ status: 403 });
    expect(hidden.public).toBe(false);
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
    expect(result.id).toMatch(/^[a-f0-9-]{36}$/);
    for (const id of [result.id, "unused"]) {
      await expect(
        call("PUT", ["comments", id], { data: "overwrite" }),
      ).rejects.toMatchObject({ status: 403 });
      await expect(call("DELETE", ["comments", id])).rejects.toMatchObject({
        status: 403,
      });
    }
    await call("PATCH", ["comments"], { read: "admin", write: "create" }, true);
    const hidden = await call("POST", ["comments"], { data: "private" });
    expect(hidden).toMatchObject({ data: "private", version: 1 });
    await expect(call("GET", ["comments", hidden.id])).rejects.toMatchObject({
      status: 403,
    });
  });

  test("pagination, replacement, PATCH refusal and collection deletion", async () => {
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
    await expect(
      call("GET", ["pages"], undefined, false, { size: 2, after: "v1.bogus" }),
    ).rejects.toMatchObject({ status: 400 });
    await call("PUT", ["pages", "a"], { data: { replacement: true } }, true);
    expect(await call("GET", ["pages", "a"])).toMatchObject({
      document: { data: { replacement: true }, version: 2 },
    });
    await expect(
      call("PATCH", ["pages", "a"], { data: {} }, true),
    ).rejects.toMatchObject({ status: 405 });
    await expect(
      call("GET", ["pages"], undefined, false, { size: 101 }),
    ).rejects.toMatchObject({ status: 400 });
    await call("DELETE", ["pages"], undefined, true);
    await expect(call("GET", ["pages", "a"])).rejects.toMatchObject({
      status: 404,
      message: expect.stringMatching(/pages does not exist.*control panel/),
    });
  });

  test("conditional writes reject stale versions and guard creation", async () => {
    await call("POST", [], { name: "guarded", read: "world" }, true);
    const guarded = (ifVersion: unknown, data: unknown = {}) =>
      call("PUT", ["guarded", "one"], { data }, true, {
        ifVersion: ifVersion as number,
      });
    expect((await guarded(0, { round: 1 })).version).toBe(1);
    await expect(guarded(0)).rejects.toMatchObject({
      status: 409,
      code: "CONFLICT",
      message: "The document already exists.",
    });
    expect((await guarded(1, { round: 2 })).version).toBe(2);
    await expect(guarded(1)).rejects.toMatchObject({
      code: "CONFLICT",
      message: expect.stringContaining("changed after that revision"),
    });
    await expect(
      call("DELETE", ["guarded", "one"], undefined, true, { ifVersion: 1 }),
    ).rejects.toMatchObject({ status: 409, code: "CONFLICT" });
    await expect(
      call("DELETE", ["guarded", "one"], undefined, true, { ifVersion: 0 }),
    ).rejects.toMatchObject({ status: 400 });
    for (const ifVersion of [-1, 1.5, "2"])
      await expect(guarded(ifVersion)).rejects.toMatchObject({ status: 400 });
    await call("DELETE", ["guarded", "one"], undefined, true, { ifVersion: 2 });
    await expect(call("GET", ["guarded", "one"])).rejects.toMatchObject({
      status: 404,
    });
  });

  test("data JSONB cannot store is refused like PostgreSQL refuses it", async () => {
    await call("POST", [], { name: "strings" }, true);
    for (const data of ["a\u0000b", { "\ud800": 1 }, ["\udc00"]])
      await expect(
        call("PUT", ["strings", "bad"], { data }, true),
      ).rejects.toMatchObject({
        status: 400,
        message: "Data contains unsupported characters or numbers.",
      });
    await expect(
      call(
        "PUT",
        ["strings", "big"],
        { data: "x".repeat(MAX_DOCUMENT_BYTES) },
        true,
      ),
    ).rejects.toMatchObject({ status: 413 });
  });

  test("batch applies conditional writes atomically", async () => {
    await call("POST", [], { name: "batched", read: "world" }, true);
    await call("PUT", ["batched", "one"], { data: { title: "a" } }, true);
    expect(
      await batch(
        {
          type: "set",
          collection: "batched",
          id: "one",
          data: { title: "b" },
          ifVersion: 1,
        },
        { type: "set", collection: "batched", id: "two", data: { title: "c" } },
        { type: "delete", collection: "batched", id: "gone" },
      ),
    ).toEqual({
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
    await expect(
      batch(
        { type: "set", collection: "batched", id: "three", data: {} },
        {
          type: "set",
          collection: "batched",
          id: "one",
          data: {},
          ifVersion: 1,
        },
      ),
    ).rejects.toMatchObject({ status: 409, code: "CONFLICT" });
    await expect(call("GET", ["batched", "three"])).rejects.toMatchObject({
      status: 404,
    });
    for (const operation of [
      { type: "update", collection: "batched", id: "one", data: {} },
      { type: "add", collection: "batched", data: {} },
      { type: "set", collection: "nowhere", id: "one", data: {} },
    ])
      await expect(batch(operation)).rejects.toMatchObject({
        status: operation.collection === "nowhere" ? 404 : 400,
      });
    await expect(
      (await siteDataBackend("alice")).batch({
        site: "alice",
        path: [],
        method: "POST",
        body: {
          operations: [{ type: "delete", collection: "batched", id: "one" }],
        },
      }),
    ).rejects.toMatchObject({ status: 403 });
  });

  test("concurrent writes cannot exceed the byte or document quota", async () => {
    const at = Date.now();
    const bytes = {
      id: "0190f5a0-0000-7000-8000-000000000001",
      name: "bytes",
      read_access: "admin",
      write_access: "world",
    };
    const filler = JSON.stringify("x".repeat(65500));
    await seed(
      [bytes],
      Array.from({ length: 160 }, (_, n) => ({
        collection_id: bytes.id,
        id: `seed${n + 1}`,
        data: filler,
        size_bytes: 65502,
        version: 1,
        created_at: at,
        updated_at: at,
      })),
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

    const quota = {
      ...bytes,
      id: "0190f5a0-0000-7000-8000-000000000002",
      name: "quota",
    };
    await seed(
      [quota],
      Array.from({ length: 9999 }, (_, n) => ({
        collection_id: quota.id,
        id: `seed${n + 1}`,
        data: "{}",
        size_bytes: 2,
        version: 1,
        created_at: at,
        updated_at: at,
      })),
    );
    const documents = await Promise.allSettled([
      call("POST", ["quota"], { data: 1 }),
      call("POST", ["quota"], { data: 2 }),
    ]);
    expect(documents.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    await call("DELETE", ["quota", "seed1"]);
    await expect(call("POST", ["quota"], { data: 3 })).resolves.toBeDefined();
  }, 60_000);

  test("public writes are limited per caller and per site, never the owner", async () => {
    await seed([], []);
    // Buckets are wall-clock minutes in the Worker, whose clock Jest cannot
    // hold: start early in a minute so the whole burst falls inside it.
    const into = Date.now() % 60_000;
    if (into > 40_000)
      await new Promise((resolve) => setTimeout(resolve, 60_500 - into));
    await call("POST", [], { name: "limited", write: "create" }, true);
    const post = (clientIp?: string, admin = false) =>
      call("POST", ["limited"], { data: 1 }, admin, { clientIp });
    const burst = await Promise.allSettled(
      Array.from({ length: 21 }, () => post("192.0.2.1")),
    );
    expect(burst.filter((r) => r.status === "fulfilled")).toHaveLength(20);
    expect(burst.find((r) => r.status === "rejected")).toMatchObject({
      reason: { status: 429 },
    });
    await expect(post(undefined, true)).resolves.toBeDefined();
    // 20 counted so far; the site's own bucket holds 60.
    for (let n = 0; n < 40; n += 1) await post(`198.51.100.${n}`);
    await expect(post("203.0.113.1")).rejects.toMatchObject({ status: 429 });
    await expect(post(undefined, true)).resolves.toBeDefined();
  }, 90_000);

  test("sign-in scope, page registration and collection creation use the object's collections", async () => {
    await seed([], []);
    // The object makes UUIDs, as PostgreSQL does in production (migration
    // 1790824144110); this schema predates that and keeps integer ids.
    for (const table of [
      "site_data_clients",
      "site_data_auth_codes",
      "site_data_access_tokens",
    ])
      await sql`alter table ${sql.table(table)} alter column collection_ids type text[]`.execute(
        db,
      );
    await sql`insert into sessions values ('alice-session', ${owner}, now() + interval '1 hour')`.execute(
      db,
    );
    await sql`insert into custom_domains(user_id,hostname,verified_at,cloudflare_status,ssl_status) values (${owner}, 'alice.example', now(), 'active', 'active')`.execute(
      db,
    );
    for (const name of ["posts", "drafts"])
      await call("POST", [], { name, read: "admin", write: "admin" }, true);
    await call("PUT", ["drafts", "one"], { data: "draft" }, true);
    const redirectUri = "https://alice.example/admin.html";
    const origin = "https://alice.example";
    const verifier = "v".repeat(43);
    const input = (collections: string[]) =>
      authorizationInput({
        site: "alice",
        redirectUri,
        state: "s".repeat(43),
        challenge: digest(verifier),
        collections,
      });
    const registration = await registerClient(owner, {
      redirectUri,
      collections: ["posts"],
    });
    const ids = (
      await (
        await siteDataBackend("alice")
      ).collections({ id: owner, loginName: "alice" }, ["posts", "drafts"])
    ).reduce<Record<string, string>>(
      (all, c) => ({ ...all, [c.name]: c.id }),
      {},
    );
    expect(registration.collection_ids).toEqual([ids.posts]);
    // Asking for a collection the site lacks creates it, privately, in the object.
    await prepareAuthorization(owner, input(["posts", "fresh"]));
    expect(await call("GET", [], undefined, true)).toMatchObject({
      collections: [
        { name: "drafts" },
        { name: "fresh", read_access: "admin", write_access: "admin" },
        { name: "posts" },
      ],
    });
    const approved = await approveAuthorization(
      owner,
      "alice-session",
      input(["posts"]),
    );
    const code = new URL(approved.redirect).searchParams.get("code")!;
    const { accessToken } = await exchangeCode(
      { code, verifier, redirectUri },
      origin,
    );
    const bearer = { token: accessToken, origin };
    await expect(
      call("GET", ["posts"], undefined, false, { bearer }),
    ).resolves.toMatchObject({
      documents: [],
    });
    await expect(
      call("GET", ["drafts", "one"], undefined, false, { bearer }),
    ).rejects.toMatchObject({ status: 403, code: "ACCESS_DENIED" });
    await expect(
      call("PATCH", ["posts"], { read: "world", write: "world" }, false, {
        bearer,
      }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      call("GET", [], undefined, false, { bearer }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      call("GET", ["posts"], undefined, false, {
        bearer: { token: accessToken, origin: "https://evil.example" },
      }),
    ).rejects.toMatchObject({ status: 401 });
  });

  test("account deletion erases the object", async () => {
    await call("POST", [], { name: "doomed" }, true);
    await eraseSiteData("alice");
    expect(
      await callSiteDataWorker<Snapshot>("alice", "export", {}),
    ).toMatchObject({
      ownerId: null,
      collections: [],
      documents: [],
    });
  });
});

integration("moving a site between stores", () => {
  let initialized = false;
  let owner: string;
  const read = async (path: string[]) =>
    (await siteDataBackend("dave")).execute({
      site: "dave",
      path,
      method: "GET",
      adminUserId: owner,
    }) as Promise<Record<string, any>>;
  const write = async (path: string[], data: unknown, ifVersion?: number) =>
    (await siteDataBackend("dave")).execute({
      site: "dave",
      path,
      method: "PUT",
      body: { data },
      adminUserId: owner,
      ifVersion,
    }) as Promise<Record<string, any>>;
  const state = async () =>
    await db
      .selectFrom("users")
      .select([
        "site_data_backend",
        "site_data_document_count",
        "site_data_bytes_used",
      ])
      .where("id", "=", owner)
      .executeTakeFirstOrThrow();

  beforeAll(async () => {
    await setupTestDatabase();
    initialized = true;
    owner = await insertUser("dave");
    for (const name of ["posts", "notes"])
      await executeData({
        site: "dave",
        path: [],
        method: "POST",
        adminUserId: owner,
        body: { name, read: "world" },
      });
    for (let n = 0; n < 30; n += 1)
      await executeData({
        site: "dave",
        path: ["posts", `p${n}`],
        method: "PUT",
        adminUserId: owner,
        body: { data: { n, title: `Post ${n}`, tags: ["a", n] } },
      });
    await executeData({
      site: "dave",
      path: ["posts", "p0"],
      method: "PUT",
      adminUserId: owner,
      body: { data: { n: 0, edited: true } },
    });
  });
  afterAll(async () => {
    if (initialized) await teardownTestDatabase();
  });

  test("a move keeps ids, revisions and timestamps, and moves back with new writes", async () => {
    const before = await postgresSnapshot(owner);
    const p0 = (await read(["posts", "p0"])).document;
    expect(p0.version).toBe(2);
    await moveSite("dave", "durable_object");
    expect((await state()).site_data_backend).toBe("durable_object");
    expect(
      await callSiteDataWorker<Snapshot>("dave", "export", {}),
    ).toMatchObject({
      ownerId: String(owner),
      collections: before.collections,
    });
    // Same revision, same stamps: a conditional write quoting it still works.
    expect((await read(["posts", "p0"])).document).toEqual(p0);
    expect(
      (await write(["posts", "p0"], { n: 0, moved: true }, 2)).version,
    ).toBe(3);
    await write(["notes", "new"], "written on the object");
    // The PostgreSQL copy is left as it was when the site moved.
    expect((await postgresSnapshot(owner)).documents).toEqual(before.documents);

    await moveSite("dave", "postgres");
    const after = await state();
    expect(after.site_data_backend).toBe("postgres");
    expect((await read(["posts", "p0"])).document).toMatchObject({
      data: { n: 0, moved: true },
      version: 3,
    });
    expect((await read(["notes", "new"])).document.data).toBe(
      "written on the object",
    );
    // The usage counters follow the restored rows.
    expect(Number(after.site_data_document_count)).toBe(31);
    // The object keeps a frozen copy: nothing can write to it any more.
    await expect(
      callSiteDataWorker("dave", "execute", {
        ownerId: String(owner),
        access: { admin: true, allowedIds: null, anonymous: false },
        path: ["notes", "late"],
        method: "PUT",
        body: { data: 1 },
      }),
    ).rejects.toMatchObject({ status: 503, code: "UNAVAILABLE" });
  });

  test("a moving site refuses writes and keeps serving reads", async () => {
    await sql`update users set site_data_backend = 'moving_to_durable_object' where id = ${owner}`.execute(
      db,
    );
    try {
      await expect(read(["posts", "p1"])).resolves.toBeDefined();
      await expect(write(["posts", "p1"], "late")).rejects.toMatchObject({
        status: 503,
        code: "UNAVAILABLE",
      });
      await expect(
        (await siteDataBackend("dave")).createCollections(
          { id: owner, loginName: "dave" },
          [{ name: "later", read_access: "admin", write_access: "admin" }],
        ),
      ).rejects.toMatchObject({ status: 503 });
    } finally {
      await sql`update users set site_data_backend = 'postgres' where id = ${owner}`.execute(
        db,
      );
    }
  });

  test("a move that cannot reach the Worker leaves the site where it was", async () => {
    const url = process.env.SITE_DATA_WORKER_URL;
    process.env.SITE_DATA_WORKER_URL = "http://127.0.0.1:9";
    try {
      await expect(moveSite("dave", "durable_object")).rejects.toMatchObject({
        status: 503,
      });
    } finally {
      process.env.SITE_DATA_WORKER_URL = url;
    }
    expect((await state()).site_data_backend).toBe("postgres");
    await expect(
      write(["posts", "p1"], "after the failed move"),
    ).resolves.toBeDefined();
  });

  test("a request resolved just before a move back is answered by PostgreSQL", async () => {
    // The object no longer serves the site, so its frozen copy must not answer.
    await expect(
      executeOnDurableObject({
        site: "dave",
        path: ["posts", "p1"],
        method: "GET",
        adminUserId: owner,
      }),
    ).resolves.toMatchObject({ document: { data: "after the failed move" } });
  });
});

integration("both stores answer the same queries", () => {
  let initialized = false;
  beforeAll(async () => {
    await setupTestDatabase();
    initialized = true;
  });
  afterAll(async () => {
    if (initialized) await teardownTestDatabase();
  });

  test("sorting, filtering and cursors match on awkward data", async () => {
    const owner = await insertUser("carol");
    const put = (collection: string, id: string, data: unknown) =>
      executeData({
        site: "carol",
        path: [collection, id],
        method: "PUT",
        adminUserId: owner,
        body: { data },
      });
    await executeData({
      site: "carol",
      path: [],
      method: "POST",
      adminUserId: owner,
      body: { name: "mixed" },
    });
    // Every type in one field, case and byte-order traps, ties, and absences.
    const values: unknown[] = [
      "apple",
      "Apple",
      "APPLE",
      "äpple",
      "zebra",
      "",
      "10",
      "9",
      "😀",
      "a b",
      0,
      -1,
      1,
      1.5,
      10,
      9,
      1e21,
      -0.25,
      2 ** 53,
      true,
      false,
      null,
      [1, 2],
      { nested: "x" },
    ];
    let n = 0;
    for (const value of values) {
      for (const copy of [0, 1]) {
        await put("mixed", `d${String(n).padStart(3, "0")}`, {
          v: value,
          group: copy ? "even" : "odd",
          rank: n % 4,
          ...(n % 5 === 0 ? {} : { sometimes: n % 3 === 0 ? "x" : n }),
        });
        n += 1;
      }
    }
    await put("mixed", "missing", { group: "odd" });
    await put("mixed", "plain", "not an object");
    // Identical timestamps, so time sorts fall back to the id.
    await sql`update site_data_documents set created_at = '2026-01-01T00:00:00.123456Z' where id like 'd00%'`.execute(
      db,
    );
    expect(await compareSite("carol")).toEqual([]);
  }, 120_000);
});
