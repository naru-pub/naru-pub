/** @jest-environment node */
import { afterAll, beforeAll, describe, expect, test } from "@jest/globals";
import { createServer, type Server } from "node:http";
import { sql } from "kysely";
import { db } from "@/lib/database";
import { configureEdge } from "@/lib/edge/sync";
import {
  approveAuthorization,
  authorizationInput,
  digest,
  exchangeCode,
  prepareAuthorization,
  registerClient,
} from "../owner-auth";
import {
  executeBatch,
  executeData,
  listCollections,
  type Collection,
  type DataCommand,
} from "../service";
import { callSiteObject, eraseSiteData } from "@/lib/edge/client";
import { MAX_DOCUMENT_BYTES } from "../validation";
import { setupTestDatabase, teardownTestDatabase } from "./test-database";

// The Durable Objects backend, end to end: PostgreSQL admits each request,
// the edge Worker (wrangler dev) stores it. scripts/test-data-durable-
// objects.sh starts both. The behaviour expected here is database.test.ts's;
// what PostgreSQL alone decides (paid status, sign-in) is checked through it.
const integration =
  process.env.NARU_DATA_TEST === "1" ? describe : describe.skip;
// Each suite sets up and tears down the schema; the pool outlives them all.
afterAll(() => db.destroy());

/** A site as the object's export and import carry it; times are epoch ms. */
type Snapshot = {
  ownerId: string | null;
  collections: Collection[];
  documents: {
    collection_id: string;
    id: string;
    data: string;
    size_bytes: number;
    version: number;
    created_at: number;
    updated_at: number;
  }[];
};

const insertUser = async (login: string) =>
  (
    await sql<{
      id: string;
    }>`insert into users(login_name) values (${login}) returning id`.execute(db)
  ).rows[0].id;

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
    executeData({
      site: "alice",
      path,
      method,
      body,
      adminUserId: admin ? owner : undefined,
      ...extra,
    }) as Promise<Record<string, any>>;
  const batch = async (...operations: Record<string, unknown>[]) =>
    executeBatch({
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
    callSiteObject("alice", "import", {
      ownerId: String(owner),
      collections,
      documents,
    });

  beforeAll(async () => {
    await setupTestDatabase();
    initialized = true;
    // The Worker's storage outlives a suite, and other suites use alice too.
    await eraseSiteData("alice");
    owner = await insertUser("alice");
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
    await expect(
      executeData({
        site: "not-enabled",
        path: ["posts"],
        method: "GET",
      }),
    ).rejects.toMatchObject({
      status: 403,
      message: "Database access is not enabled for this site.",
    });
    await expect(
      executeData({
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

  test("document data rejects NUL and unpaired surrogates", async () => {
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
      executeBatch({
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
      await listCollections({ id: owner, loginName: "alice" }, [
        "posts",
        "drafts",
      ])
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
    expect(await callSiteObject<Snapshot>("alice", "export", {})).toMatchObject(
      {
        ownerId: null,
        collections: [],
        documents: [],
      },
    );
  });
});

integration("answering visitors at the edge", () => {
  let initialized = false;
  let owner: string;
  let origin: Server;
  /** What reached the stand-in control plane. */
  const passed: { method: string; url: string; body: string }[] = [];
  const worker = process.env.EDGE_WORKER_URL!;
  const visit = (path: string, init: RequestInit = {}) =>
    fetch(`${worker}/api/data/v1/erin/${path}`, {
      ...init,
      headers: {
        Origin: "https://erin.example",
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...init.headers,
      },
    });
  const owned = async (method: string, path: string[], body?: object) =>
    executeData({
      site: "erin",
      path,
      method,
      body: body as Record<string, unknown>,
      adminUserId: owner,
    });

  beforeAll(async () => {
    await setupTestDatabase();
    initialized = true;
    await eraseSiteData("erin");
    owner = await insertUser("erin");
    await owned("POST", [], { name: "posts", read: "world", write: "create" });
    await owned("POST", [], { name: "secret" });
    await owned("PUT", ["posts", "one"], { data: { title: "first" } });
    await configureEdge("erin", owner);
    origin = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      passed.push({
        method: request.method!,
        url: request.url!,
        body: Buffer.concat(chunks).toString(),
      });
      response.writeHead(299, { "Content-Type": "application/json" });
      response.end('{"from":"control plane"}');
    });
    await new Promise<void>((resolve) =>
      origin.listen(
        Number(process.env.SITE_DATA_TEST_ORIGIN_PORT),
        "127.0.0.1",
        resolve,
      ),
    );
  });
  afterAll(async () => {
    origin.closeAllConnections();
    await new Promise((resolve) => origin.close(resolve));
    if (initialized) await teardownTestDatabase();
  });

  test("a visitor's read is answered at the edge exactly as the control plane answers it", async () => {
    const response = await visit("posts/one?fresh=1");
    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.json();
    expect(body).toEqual({
      document: {
        id: "one",
        data: { title: "first" },
        revision: "r1.1",
        createdAt: expect.any(String),
        updatedAt: expect.any(String),
      },
    });
    expect(passed).toEqual([]);
    const list = await visit("posts");
    expect(list.headers.get("cache-control")).toBe(
      "public, max-age=0, s-maxage=10",
    );
    expect(await list.json()).toMatchObject({
      documents: [{ id: "one" }],
      nextCursor: null,
    });
  });

  test("public reads are cached for seconds; fresh reads are not", async () => {
    expect((await (await visit("posts?size=5")).json()).documents).toHaveLength(
      1,
    );
    await owned("PUT", ["posts", "two"], { data: { title: "second" } });
    const cached = await visit("posts?size=5");
    expect(cached.headers.get("cache-control")).toBe(
      "public, max-age=0, s-maxage=10",
    );
    expect((await cached.json()).documents).toHaveLength(1);
    expect(
      (await (await visit("posts?size=5&fresh=1")).json()).documents,
    ).toHaveLength(2);
  });

  test("visitor writes, refusals and errors keep the v1 protocol", async () => {
    const created = await visit("posts", {
      method: "POST",
      body: JSON.stringify({ data: { title: "from a visitor" } }),
    });
    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({
      data: { title: "from a visitor" },
      revision: "r1.1",
    });
    const denied = await visit("secret");
    expect(denied.status).toBe(403);
    expect(await denied.json()).toEqual({
      error: {
        code: "ACCESS_DENIED",
        message:
          "Collection secret is not publicly readable. Change its read access in the control panel, or sign in.",
      },
    });
    const replace = await visit("posts/one?ifRevision=r1.1", {
      method: "PUT",
      body: JSON.stringify({ data: {} }),
    });
    expect(replace.status).toBe(403);
    expect((await visit("nowhere")).status).toBe(404);
    expect((await visit("posts?size=500")).status).toBe(400);
    const wrongType = await visit("posts", {
      method: "POST",
      body: "{}",
      headers: { "Content-Type": "text/plain" },
    });
    expect(wrongType.status).toBe(415);
    const preflight = await visit("posts", { method: "OPTIONS" });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe(
      "https://erin.example",
    );
    expect(passed).toEqual([]);
  });

  test("owners, media and batches go on to the control plane, body and all", async () => {
    passed.length = 0;
    const signedIn = await visit("posts", {
      method: "POST",
      body: JSON.stringify({ data: 1 }),
      headers: { Authorization: `Bearer ${"t".repeat(43)}` },
    });
    expect(signedIn.status).toBe(299);
    await visit("_files", { method: "POST", body: '{"name":"a.png"}' });
    await visit("_batch", { method: "POST", body: '{"operations":[]}' });
    expect(passed).toEqual([
      { method: "POST", url: "/api/data/v1/erin/posts", body: '{"data":1}' },
      {
        method: "POST",
        url: "/api/data/v1/erin/_files",
        body: '{"name":"a.png"}',
      },
      {
        method: "POST",
        url: "/api/data/v1/erin/_batch",
        body: '{"operations":[]}',
      },
    ]);
  });

  test("without a current paid-status confirmation, the edge hands every request back", async () => {
    passed.length = 0;
    // As when the sync job has stopped, or the feature was revoked.
    await callSiteObject("erin", "configure", {
      ownerId: String(owner),
      entitledUntil: null,
      confirmedUntil: Date.now() - 1,
    });
    expect((await visit("posts/one")).status).toBe(299);
    const write = await visit("posts", { method: "POST", body: '{"data":2}' });
    expect(write.status).toBe(299);
    await configureEdge("erin", owner);
    expect(passed).toEqual([
      { method: "GET", url: "/api/data/v1/erin/posts/one", body: "" },
      { method: "POST", url: "/api/data/v1/erin/posts", body: '{"data":2}' },
    ]);
    expect((await visit("posts/one?fresh=1")).status).toBe(200);
  });

  test("paid status is decided by the control plane, never refused at the edge", async () => {
    // Lapsed, and the edge told so: the control plane refuses, on time.
    await sql`update users set supporter_comp = false, supporter_until = now() - interval '60 days' where id = ${owner}`.execute(
      db,
    );
    await configureEdge("erin", owner);
    passed.length = 0;
    expect((await visit("posts/one?fresh=1")).status).toBe(299);
    // Paid again, before any sync: the edge still holds the old date, and
    // sends visitors on rather than refusing them for the minutes until then.
    await sql`update users set supporter_comp = true where id = ${owner}`.execute(
      db,
    );
    expect((await visit("posts/one?fresh=1")).status).toBe(299);
    expect(passed).toHaveLength(2);
    // The next sync lets the edge answer again.
    await configureEdge("erin", owner);
    expect((await visit("posts/one?fresh=1")).status).toBe(200);
    expect(passed).toHaveLength(2);
  });

  test("a site's visitors stop at its monthly budget; its owner does not", async () => {
    await callSiteObject("erin", "configure", {
      ownerId: String(owner),
      entitledUntil: null,
      confirmedUntil: Date.now() + 60_000,
      monthlyRequests: 3,
    });
    // The object's count survives from the tests above, so start a new one.
    await callSiteObject(
      "erin",
      "import",
      await callSiteObject("erin", "export", {}),
    );
    await callSiteObject("erin", "configure", {
      ownerId: String(owner),
      entitledUntil: null,
      confirmedUntil: Date.now() + 60_000,
      monthlyRequests: 3,
    });
    for (let n = 0; n < 3; n += 1)
      expect((await visit(`posts/one?fresh=1&n=${n}`)).status).toBe(200);
    const refused = await visit("posts/one?fresh=1&n=3");
    expect(refused.status).toBe(429);
    expect(await refused.json()).toMatchObject({
      error: {
        code: "RATE_LIMITED",
        message: expect.stringContaining("3 database requests for the month"),
      },
    });
    // Visitors reaching it through the control plane are counted too.
    await expect(
      executeData({
        site: "erin",
        path: ["posts", "one"],
        method: "GET",
      }),
    ).rejects.toMatchObject({ status: 429 });
    await expect(owned("GET", ["posts", "one"])).resolves.toBeDefined();
  });
});
