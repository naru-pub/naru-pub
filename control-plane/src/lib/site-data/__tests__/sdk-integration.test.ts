/** @jest-environment node */
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  jest,
  test,
} from "@jest/globals";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { sql } from "kysely";

let mockOrigin = "";
const mockObjects = new Map<
  string,
  { contentLength: number; contentType: string }
>();

import { db } from "@/lib/database";
import { runSdkStress } from "./sdk-stress";
import { runSdkMixedStress } from "./sdk-mixed-stress";
import { GET as dataRoute } from "@/app/(main)/api/data/v1/[site]/[[...path]]/route";
import { POST as authRoute } from "@/app/(main)/api/data-auth/v1/[action]/route";
import { executeData } from "../service";
import { mediaStorage } from "../media";
import {
  approveAuthorization,
  authorizationInput,
  digest,
  registerClient,
} from "../owner-auth";
import { setupTestDatabase, teardownTestDatabase } from "./test-database";
import {
  createNaru,
  type NaruClient,
  type Admin,
} from "../../../../public/sdk/1.0.0/naru.js";

const integration =
  process.env.NARU_DATA_TEST === "1" ? describe : describe.skip;

// Real SDK -> native fetch -> HTTP -> actual route -> service -> PostgreSQL.
// The adapter replaces Next's HTTP listener, not the route or its responses.
integration("SDK and data API contract", () => {
  let ready = false;
  let server: Server | undefined;
  let origin: string;
  let accessToken: string;
  let sessionKey: string;
  let admin: Admin;
  let naru: NaruClient;
  const storage = new Map<string, string>();
  const nativeFetch = globalThis.fetch;
  const browserGlobals = ["location", "sessionStorage", "history"] as const;
  const oldGlobals = browserGlobals.map((name) =>
    Object.getOwnPropertyDescriptor(globalThis, name),
  );

  beforeAll(async () => {
    await setupTestDatabase();
    ready = true;
    server = createServer(async (incoming, outgoing) => {
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
        if (
          incoming.url?.startsWith("/__contract_upload/") &&
          incoming.method === "PUT"
        ) {
          const key = decodeURIComponent(
            incoming.url.slice("/__contract_upload/".length),
          );
          mockObjects.set(key, {
            contentLength: Buffer.concat(chunks).byteLength,
            contentType: incoming.headers["content-type"] || "",
          });
          outgoing.writeHead(200);
          outgoing.end();
          return;
        }
        const headers = new Headers();
        for (const [name, value] of Object.entries(incoming.headers))
          if (value !== undefined)
            headers.set(name, Array.isArray(value) ? value.join(", ") : value);
        const request = new Request(`${origin}${incoming.url}`, {
          method: incoming.method,
          headers,
          ...(chunks.length ? { body: Buffer.concat(chunks) } : {}),
        });
        const parts = new URL(request.url).pathname.split("/");
        const response =
          parts[2] === "data-auth"
            ? await authRoute(request, {
                params: Promise.resolve({ action: parts[4] }),
              })
            : await dataRoute(request, {
                params: Promise.resolve({
                  site: parts[4],
                  path: parts.slice(5),
                }),
              });
        outgoing.writeHead(
          response.status,
          Object.fromEntries(response.headers),
        );
        outgoing.end(Buffer.from(await response.arrayBuffer()));
      } catch (error) {
        outgoing.destroy(error as Error);
      }
    });
    await new Promise<void>((resolve, reject) => {
      server!.once("error", reject);
      server!.listen(0, "127.0.0.1", resolve);
    });
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    mockOrigin = origin;
    // Object storage is the sole external boundary in this suite.
    // Authorization, media rows, admin scope, HTTP, and finalization stay real.
    jest
      .spyOn(mediaStorage, "authorizeUpload")
      .mockImplementation(
        async (key) =>
          `${mockOrigin}/__contract_upload/${encodeURIComponent(key)}`,
      );
    jest.spyOn(mediaStorage, "headObject").mockImplementation(async (key) => {
      const object = mockObjects.get(key);
      if (!object) throw new Error("Object does not exist.");
      return {
        ContentLength: object.contentLength,
        ContentType: object.contentType,
        $metadata: {},
      };
    });
    // The SDK only ever calls https://naru.pub; here that is this loopback
    // server. Node fetch does not add a browser Origin header. Everything else,
    // including HTTP errors, JSON serialization and response bodies, crosses
    // the socket.
    globalThis.fetch = (input, init) => {
      const url = new URL(String(input));
      if (url.origin === "https://naru.pub")
        input = `${origin}${url.pathname}${url.search}`;
      else if (url.origin !== origin)
        throw new Error("SDK test attempted nonlocal HTTP");
      const headers = new Headers(init?.headers);
      headers.set("Origin", origin);
      return nativeFetch(input, { ...init, headers });
    };
    const userId = (
      await sql<{
        id: string;
      }>`insert into users(login_name) values ('alice') returning id`.execute(
        db,
      )
    ).rows[0].id;
    await sql`insert into sessions values ('sdk-session', ${userId}, now() + interval '1 hour')`.execute(
      db,
    );
    const collections = ["crud", "feed", "atomic", "private"];
    for (const name of collections)
      await executeData({
        site: "alice",
        adminUserId: userId,
        method: "POST",
        path: [],
        body: {
          name,
          read: name === "private" ? "admin" : "world",
          write: name === "private" ? "admin" : "world",
        },
      });
    // Registered as one address of the page and signed in from another; Naru
    // serves both as the page /admin/, and returns to the one signed in from.
    const redirectUri = `${origin}/admin`;
    await registerClient(userId, {
      redirectUri: `${origin}/admin/index.html`,
      collections,
    });
    const verifier = "v".repeat(43);
    const approval = await approveAuthorization(
      userId,
      "sdk-session",
      authorizationInput({
        site: "alice",
        redirectUri,
        collections,
        state: "s".repeat(43),
        challenge: digest(verifier),
      }),
    );
    // The page Naru redirects back to, with the code, and the transaction
    // signIn() would have left in this tab before leaving.
    const location = new URL(approval.redirect);
    const values = {
      location: Object.assign(location, { assign() {} }),
      sessionStorage: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => storage.set(key, value),
        removeItem: (key: string) => storage.delete(key),
      },
      history: {
        state: null,
        replaceState: (_state: unknown, _title: string, url: string) =>
          (location.href = url),
      },
    };
    for (const name of browserGlobals)
      Object.defineProperty(globalThis, name, {
        configurable: true,
        value: values[name],
      });
    sessionKey = `naru:owner:https://naru.pub:alice:${redirectUri}`;
    storage.set(
      `${sessionKey}:pending`,
      JSON.stringify({
        verifier,
        state: "s".repeat(43),
        startedAt: Date.now(),
      }),
    );
    naru = createNaru({ site: "alice" });
    admin = (await naru.auth.session())!;
    expect(location.href).toBe(redirectUri);
    accessToken = JSON.parse(storage.get(sessionKey)!).accessToken;
  }, 30000);

  afterAll(async () => {
    jest.restoreAllMocks();
    mockObjects.clear();
    mockOrigin = "";
    globalThis.fetch = nativeFetch;
    browserGlobals.forEach((name, index) => {
      const old = oldGlobals[index];
      if (old) Object.defineProperty(globalThis, name, old);
      else Reflect.deleteProperty(globalThis, name);
    });
    try {
      if (server?.listening) {
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) =>
          server!.close((error) => (error ? reject(error) : resolve())),
        );
      }
      if (ready) await teardownTestDatabase();
    } finally {
      await db.destroy();
    }
  });

  (process.env.NARU_SDK_STRESS === "1" ? test : test.skip)(
    "local SDK stress",
    async () => runSdkStress({ naru, admin, origin, nativeFetch }),
    600000,
  );

  (process.env.NARU_SDK_MIXED_STRESS === "1" ? test : test.skip)(
    "local SDK mixed stress",
    async () => runSdkMixedStress({ naru, admin }),
    600000,
  );

  test("CRUD preserves JSON, metadata, revisions, and semantic failures", async () => {
    const posts = admin.collection("crud");
    const added = await posts.add({
      title: "한글",
      nested: { value: null },
      tags: [1, true],
      version: 7,
    });
    expect(added).toEqual({
      data: {
        title: "한글",
        nested: { value: null },
        tags: [1, true],
        version: 7,
      },
      id: expect.any(String),
      revision: "r1.1",
      createdAt: expect.any(String),
      updatedAt: expect.any(String),
    });
    // A write reports the very stamps the read comes back with, so a caller
    // rendering what it just saved never has to invent one.
    const first = await posts.get(added.id);
    expect(first).toEqual({
      ...added,
      data: {
        title: "한글",
        nested: { value: null },
        tags: [1, true],
        version: 7,
      },
    });
    expect(
      await posts.set(
        added.id,
        { replaced: true },
        { condition: { revision: first.revision } },
      ),
    ).toEqual({
      id: added.id,
      revision: "r1.2",
      data: { replaced: true },
      createdAt: first.createdAt,
      updatedAt: expect.any(String),
    });
    const replaced = await posts.get(added.id);
    expect(replaced.createdAt).toBe(first.createdAt);
    expect(replaced.data).toEqual({ replaced: true });
    await expect(
      posts.set(added.id, null, {
        condition: { revision: "r1.1" as typeof first.revision },
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(
      posts.delete(added.id, {
        condition: { revision: "r1.1" as typeof first.revision },
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(
      await posts.delete(added.id, {
        condition: { revision: "r1.2" as typeof first.revision },
      }),
    ).toBeUndefined();
    await expect(posts.get(added.id)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await posts.delete(added.id);
    // "Delete only if absent" could only ever do nothing, alone or batched.
    // The SDK refuses it before sending; the server refuses it regardless.
    await expect(
      posts.delete(added.id, {
        condition: { absent: true } as never,
      }),
    ).rejects.toThrow(TypeError);
    await expect(
      admin.batch([
        {
          collection: "crud",
          delete: { id: added.id, condition: { absent: true } as never },
        },
      ]),
    ).rejects.toThrow(TypeError);
    const absentDelete = await nativeFetch(
      `${origin}/api/data/v1/alice/crud/${added.id}?ifAbsent=1`,
      {
        method: "DELETE",
        headers: { Origin: origin, Authorization: `Bearer ${accessToken}` },
      },
    );
    expect((await absentDelete.json()).error.code).toBe("INVALID_REQUEST");
    // Partial updates are not part of the contract.
    const patch = await nativeFetch(`${origin}/api/data/v1/alice/crud/new`, {
      method: "PATCH",
      headers: { Origin: origin, "Content-Type": "application/json" },
      body: JSON.stringify({ data: { a: 1 } }),
    });
    await patch.arrayBuffer();
    expect(patch.status).toBe(405);
    await posts.set("new", null, { condition: { absent: true } });
    await expect(
      posts.set("new", false, { condition: { absent: true } }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  test("filtered pages and totals use the same real query contract", async () => {
    const feed = admin.collection<{ rank: number; visible: boolean }>("feed");
    for (let rank = 1; rank <= 5; rank++)
      await feed.set(`post_${rank}`, { rank, visible: rank !== 3 });
    const query = {
      filter: { rank: { gte: 2 }, visible: true },
      sort: [["rank", "desc"]] as [[string, "desc"]],
    };
    const first = await feed.list({
      ...query,
      size: 2,
      includeTotal: true,
    });
    expect(first.totalCount).toBe(3);
    expect(first.documents.map((d) => d.id)).toEqual(["post_5", "post_4"]);
    expect(first.nextCursor).toEqual(expect.any(String));
    const second = await feed.list({
      ...query,
      size: 2,
      after: first.nextCursor,
    });
    expect(second.documents.map((d) => d.id)).toEqual(["post_2"]);
    expect(second.nextCursor).toBeNull();
    await expect(
      feed.list({
        ...query,
        filter: { visible: false },
        after: first.nextCursor,
      }),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    // An empty filter and a null token are the first, unfiltered page.
    const everything = await feed.list({
      filter: {},
      after: null,
      includeTotal: true,
    });
    expect(everything.totalCount).toBe(5);
    expect(await feed.count({ filter: query.filter })).toBe(3);
    expect(await feed.count()).toBe(5);
    const walked: string[] = [];
    for await (const page of feed.pages({ ...query, size: 2 }))
      walked.push(...page.documents.map((d) => d.id));
    expect(walked).toEqual(["post_5", "post_4", "post_2"]);
  });

  test("admin batches report each write and roll back conflicts across collections", async () => {
    await expect(naru.collection("private").list()).rejects.toMatchObject({
      code: "ACCESS_DENIED",
    });
    const privateWrite = await admin
      .collection("private")
      .add({ secret: true });
    const result = await admin.batch([
      {
        collection: "atomic",
        set: { id: "one", data: { original: true } },
      },
      { collection: "atomic", delete: { id: "missing" } },
    ]);
    // A set reports what a later conditional write quotes; a delete, null.
    expect(result).toEqual([
      {
        id: "one",
        revision: "r1.1",
        createdAt: expect.any(String),
        updatedAt: expect.any(String),
      },
      null,
    ]);
    const privateId = privateWrite.id;
    await expect(
      admin.batch([
        {
          collection: "atomic",
          set: {
            id: "one",
            data: { changed: true },
            condition: { revision: "r1.1" as typeof privateWrite.revision },
          },
        },
        {
          collection: "private",
          delete: {
            id: privateId,
            condition: { revision: "r1.9" as typeof privateWrite.revision },
          },
        },
      ]),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await admin.collection("atomic").get("one")).toMatchObject({
      revision: "r1.1",
      data: { original: true },
    });
    expect((await admin.collection("private").get(privateId)).data).toEqual({
      secret: true,
    });
  });

  test("the website media surface contains only upload", () => {
    expect(Object.keys(admin.media)).toEqual(["upload"]);
  });

  test("admin upload authorizes, transfers, and finalizes a real media row", async () => {
    const source = new File(["contract bytes"], "contract.txt", {
      type: "text/plain",
    });
    const file = await admin.media.upload(source);

    expect(file).toEqual({
      url: expect.stringMatching(/^https:\/\/media\.naru\.pub\//),
      name: "contract.txt",
      contentType: "text/plain",
      size: source.size,
    });
    const row = await db
      .selectFrom("site_data_files")
      .select(["id", "object_key", "status", "size_bytes", "content_type"])
      .where("object_key", "=", new URL(file.url).pathname.slice(1))
      .executeTakeFirstOrThrow();
    expect(row).toMatchObject({
      status: "ready",
      size_bytes: source.size,
      content_type: "text/plain",
    });
    expect(mockObjects.get(row.object_key)).toEqual({
      contentLength: source.size,
      contentType: "text/plain",
    });
  });

  // The library is the control panel's; a website token only adds to it.
  test("a website token can neither list nor delete media", async () => {
    const file = await db
      .selectFrom("site_data_files")
      .select("id")
      .where("status", "=", "ready")
      .executeTakeFirstOrThrow();
    for (const [method, path] of [
      ["GET", "_files"],
      ["DELETE", `_files/${file.id}`],
    ]) {
      const response = await nativeFetch(
        `${origin}/api/data/v1/alice/${path}`,
        {
          method,
          headers: { Origin: origin, Authorization: `Bearer ${accessToken}` },
        },
      );
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({
        error: {
          code: "ACCESS_DENIED",
          message: "Website tokens can only upload files.",
        },
      });
    }
    expect(
      await db
        .selectFrom("site_data_files")
        .select("id")
        .where("id", "=", file.id)
        .executeTakeFirst(),
    ).toBeDefined();
  });

  // Public reads are the request a site makes most, and letting a shared cache
  // hold them is the whole reason the SDK stopped forcing no-store. What must
  // never be cacheable is a response that depended on a credential.
  test("only anonymous reads of world collections are marked cacheable", async () => {
    const anonymous = await nativeFetch(`${origin}/api/data/v1/alice/feed`, {
      headers: { Origin: "https://example.test" },
    });
    await anonymous.arrayBuffer();
    expect(anonymous.headers.get("cache-control")).toContain("s-maxage");
    expect(anonymous.headers.get("vary")).toContain("Authorization");

    // Same URL, but with a token: an intermediary that ignores Vary must not be
    // handed something it could replay to a stranger.
    const authorized = await nativeFetch(`${origin}/api/data/v1/alice/feed`, {
      headers: { Origin: origin, Authorization: `Bearer ${accessToken}` },
    });
    await authorized.arrayBuffer();
    expect(authorized.headers.get("cache-control")).toBe("no-store");

    // An admin-only collection is never cacheable, whoever asks.
    const priv = await nativeFetch(`${origin}/api/data/v1/alice/private`, {
      headers: { Origin: origin, Authorization: `Bearer ${accessToken}` },
    });
    await priv.arrayBuffer();
    expect(priv.headers.get("cache-control")).toBe("no-store");

    // Neither is a write, nor an error.
    const written = await nativeFetch(`${origin}/api/data/v1/alice/feed`, {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json" },
      body: JSON.stringify({ data: { cacheable: false } }),
    });
    await written.arrayBuffer();
    expect(written.headers.get("cache-control")).toBe("no-store");
    const missing = await nativeFetch(`${origin}/api/data/v1/alice/nope`, {
      headers: { Origin: "https://example.test" },
    });
    await missing.arrayBuffer();
    expect(missing.status).toBe(404);
    expect(missing.headers.get("cache-control")).toBe("no-store");
  });

  test("an admin request past halfway renews the session the SDK holds", async () => {
    const stored = () => JSON.parse(storage.get(sessionKey)!).expiresAt;
    const issued = stored();
    await admin.collection("crud").list();
    // A token in the first half of its window is left where it is.
    expect(stored()).toBe(issued);
    await db
      .updateTable("site_data_access_tokens")
      .set({ expires_at: new Date(Date.now() + 60000) })
      .where("hash", "=", digest(accessToken))
      .execute();
    await admin.collection("crud").list();
    const renewed = stored();
    expect(renewed).toBeGreaterThan(Date.now() + 3500000);
    // Measured on the browser's clock from a duration, so equal to the
    // server's instant only to within the request's latency and rounding.
    const serverExpiry = (
      await db
        .selectFrom("site_data_access_tokens")
        .select("expires_at")
        .where("hash", "=", digest(accessToken))
        .executeTakeFirstOrThrow()
    ).expires_at.getTime();
    expect(Math.abs(renewed - serverExpiry)).toBeLessThan(5000);
    // An anonymous read carries no session to renew.
    await naru.collection("crud").list();
    expect(stored()).toBe(renewed);
  });

  test("SDK signout revokes the real admin token", async () => {
    await admin.signOut();
    expect(await naru.auth.session()).toBeNull();
    await expect(admin.collection("private").list()).rejects.toMatchObject({
      code: "AUTH_REQUIRED",
    });
    const copiedTokenResponse = await nativeFetch(
      `${origin}/api/data/v1/alice/private`,
      {
        headers: { Origin: origin, Authorization: `Bearer ${accessToken}` },
      },
    );
    expect(copiedTokenResponse.status).toBe(401);
    await copiedTokenResponse.arrayBuffer();
    expect(
      (await db.selectFrom("site_data_access_tokens").selectAll().execute())
        .length,
    ).toBe(0);
  });
});
