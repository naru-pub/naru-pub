/** @jest-environment node */
import { afterAll, beforeAll, describe, expect, test } from "@jest/globals";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { sql } from "kysely";
import { db } from "@/lib/database";
import { GET as dataRoute } from "@/app/(main)/api/data/[site]/[[...path]]/route";
import { POST as authRoute } from "@/app/(main)/api/data-auth/[action]/route";
import { executeData } from "../service";
import {
  approveAuthorization,
  authorizationInput,
  digest,
  exchangeCode,
  registerClient,
  siteClientId,
} from "../owner-auth";
import { setupTestDatabase, teardownTestDatabase } from "./test-database";
import {
  createDatabase,
  type OwnerDatabase,
} from "../../../../public/sdk/1.0.0/naru-data.js";

const integration =
  process.env.NARU_DATA_TEST === "1" ? describe : describe.skip;

// Real SDK -> native fetch -> HTTP -> actual route -> service -> PostgreSQL.
// The adapter replaces Next's HTTP listener, not the route or its responses.
integration("SDK and data API contract", () => {
  let ready = false;
  let server: Server | undefined;
  let origin: string;
  let accessToken: string;
  let owner: OwnerDatabase;
  let ownerId: number;
  let publicDb: ReturnType<typeof createDatabase>;
  const nativeFetch = globalThis.fetch;
  const oldWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const oldFeatureMode = process.env.FEATURE_ACCESS_MODE;

  beforeAll(async () => {
    await setupTestDatabase();
    ready = true;
    server = createServer(async (incoming, outgoing) => {
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
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
                params: Promise.resolve({ action: parts[3] }),
              })
            : await dataRoute(request, {
                params: Promise.resolve({
                  site: parts[3],
                  path: parts.slice(4),
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
    // Node fetch does not add a browser Origin header. Everything else, including
    // HTTP errors, JSON serialization and response bodies, crosses the socket.
    globalThis.fetch = (input, init) => {
      if (new URL(String(input)).origin !== origin)
        throw new Error("SDK test attempted nonlocal HTTP");
      const headers = new Headers(init?.headers);
      headers.set("Origin", origin);
      return nativeFetch(input, { ...init, headers });
    };
    const userId = (
      await sql<{
        id: number;
      }>`insert into users(login_name) values ('alice') returning id`.execute(
        db,
      )
    ).rows[0].id;
    await sql`insert into sessions values ('sdk-session', ${userId}, now() + interval '1 hour')`.execute(
      db,
    );
    const collections = ["crud", "feed", "atomic", "private", "raw"];
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
    const redirectUri = `${origin}/admin`;
    await registerClient(userId, { redirectUri, collections });
    const clientId = await siteClientId(userId),
      verifier = "v".repeat(43);
    const approval = await approveAuthorization(
      userId,
      "sdk-session",
      authorizationInput({
        site: "alice",
        clientId,
        redirectUri,
        collections,
        state: "s".repeat(43),
        challenge: digest(verifier),
      }),
    );
    const token = await exchangeCode(
      {
        code: new URL(approval.redirect).searchParams.get("code"),
        verifier,
        clientId,
        redirectUri,
      },
      origin,
    );
    accessToken = token.accessToken;
    ownerId = userId;
    const storage = new Map<string, string>([
      [
        `naru:owner:${origin}:alice:session:${redirectUri}`,
        JSON.stringify({
          accessToken: token.accessToken,
          expiresAt: token.expiresAt,
          redirectUri,
        }),
      ],
    ]);
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        location: new URL(redirectUri),
        sessionStorage: {
          getItem: (key: string) => storage.get(key) ?? null,
          removeItem: (key: string) => storage.delete(key),
        },
      },
    });
    publicDb = createDatabase({ site: "alice", controlPlaneOrigin: origin });
    owner = (await publicDb.completeOwnerSignIn())!;
  }, 30000);

  afterAll(async () => {
    globalThis.fetch = nativeFetch;
    if (oldWindow) Object.defineProperty(globalThis, "window", oldWindow);
    else Reflect.deleteProperty(globalThis, "window");
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
      if (oldFeatureMode === undefined) delete process.env.FEATURE_ACCESS_MODE;
      else process.env.FEATURE_ACCESS_MODE = oldFeatureMode;
    }
  });

  test("CRUD preserves JSON, metadata, versions, and HTTP failures", async () => {
    const posts = publicDb.collection("crud");
    const added = await posts.add({
      title: "한글",
      nested: { value: null },
      tags: [1, true],
    });
    expect(added).toEqual({
      id: expect.any(String),
      version: 1,
      createdAt: expect.any(String),
      updatedAt: expect.any(String),
    });
    // A write reports the very stamps the read comes back with, so a caller
    // rendering what it just saved never has to invent one.
    const first = await posts.get(added.id);
    expect(first).toEqual({
      ...added,
      data: { title: "한글", nested: { value: null }, tags: [1, true] },
    });
    expect(
      await posts.set(
        added.id,
        { replaced: true },
        { ifVersion: first.version },
      ),
    ).toEqual({
      id: added.id,
      version: 2,
      createdAt: first.createdAt,
      updatedAt: expect.any(String),
    });
    const replaced = await posts.get(added.id);
    expect(replaced.createdAt).toBe(first.createdAt);
    expect(replaced.data).toEqual({ replaced: true });
    await expect(
      posts.set(added.id, null, { ifVersion: 1 }),
    ).rejects.toMatchObject({ status: 409, code: "VERSION_CONFLICT" });
    await posts.update(
      added.id,
      { count: 2 },
      { ifVersion: 2, unset: ["replaced"] },
    );
    expect((await posts.get(added.id)).data).toEqual({ count: 2 });
    await expect(
      posts.delete(added.id, { ifVersion: 2 }),
    ).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
    expect(await posts.delete(added.id, { ifVersion: 3 })).toEqual({
      success: true,
    });
    await expect(posts.get(added.id)).rejects.toMatchObject({ status: 404 });
    expect(await posts.delete(added.id)).toEqual({ success: true });
    await posts.set("new", null, { ifVersion: 0 });
    await expect(
      posts.set("new", false, { ifVersion: 0 }),
    ).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
  });

  test("filtered pages, count, and all use the same real query contract", async () => {
    const feed = publicDb.collection<{ rank: number; visible: boolean }>(
      "feed",
    );
    for (let rank = 1; rank <= 5; rank++)
      await feed.set(`post_${rank}`, { rank, visible: rank !== 3 });
    const query = {
      where: { rank: { gte: 2 }, visible: true },
      orderBy: "data.rank" as const,
      direction: "desc" as const,
    };
    expect(await feed.count({ where: query.where })).toBe(3);
    const first = await feed.list({ ...query, limit: 2 });
    expect(first.documents.map((d) => d.id)).toEqual(["post_5", "post_4"]);
    expect(first.nextPageToken).toEqual(expect.any(String));
    const second = await feed.list({
      ...query,
      limit: 2,
      pageToken: first.nextPageToken,
    });
    expect(second.documents.map((d) => d.id)).toEqual(["post_2"]);
    expect(second.nextPageToken).toBeNull();
    const ids: string[] = [];
    for await (const document of feed.all({ ...query, limit: 1 }))
      ids.push(document.id);
    expect(ids).toEqual(["post_5", "post_4", "post_2"]);
    await expect(
      feed.list({
        ...query,
        where: { visible: false },
        pageToken: first.nextPageToken,
      }),
    ).rejects.toMatchObject({ status: 400 });
  });

  test("owner batches return operation results and roll back conflicts across collections", async () => {
    await expect(publicDb.collection("private").list()).rejects.toMatchObject({
      status: 403,
    });
    const result = await owner.batch([
      {
        type: "set",
        collection: "atomic",
        id: "one",
        data: { original: true },
      },
      { type: "add", collection: "private", data: { secret: true } },
      { type: "delete", collection: "atomic", id: "missing" },
    ]);
    const stamps = {
      version: 1,
      createdAt: expect.any(String),
      updatedAt: expect.any(String),
    };
    expect(result.results).toEqual([
      { id: "one", ...stamps },
      { id: expect.any(String), ...stamps },
      { success: true },
    ]);
    const privateId = result.results[1].id;
    await expect(
      owner.batch([
        {
          type: "update",
          collection: "atomic",
          id: "one",
          data: { changed: true },
          ifVersion: 1,
        },
        { type: "delete", collection: "private", id: privateId, ifVersion: 9 },
      ]),
    ).rejects.toMatchObject({ status: 409, code: "VERSION_CONFLICT" });
    expect(await owner.collection("atomic").get("one")).toMatchObject({
      version: 1,
      data: { original: true },
    });
    expect((await owner.collection("private").get(privateId)).data).toEqual({
      secret: true,
    });
  });

  test("read parsers validate stored schemaless data and identify failures", async () => {
    const raw = publicDb.collection("raw");
    await raw.set("a", { title: "valid" });
    await raw.set("b", { title: 42 });
    const parsed = createDatabase({
      site: "alice",
      controlPlaneOrigin: origin,
      collections: {
        raw: {
          parse(data) {
            if (
              !data ||
              typeof data !== "object" ||
              Array.isArray(data) ||
              typeof data.title !== "string"
            )
              throw new Error("title must be a string");
            return { title: data.title.toUpperCase() };
          },
        },
      },
    }).collection("raw");
    expect((await parsed.get("a")).data).toEqual({ title: "VALID" });
    const failure = {
      code: "DOCUMENT_VALIDATION_FAILED",
      collection: "raw",
      documentId: "b",
    };
    await expect(parsed.get("b")).rejects.toMatchObject(failure);
    await expect(parsed.list()).rejects.toMatchObject(failure);
    const iterator = parsed.all({ limit: 1 });
    expect((await iterator.next()).value?.data).toEqual({ title: "VALID" });
    await expect(iterator.next()).rejects.toMatchObject(failure);
    expect((await raw.get("b")).data).toEqual({ title: 42 });
    expect(await parsed.count()).toBe(2);
  });

  test("the media library pages, filters on metadata and patches it", async () => {
    // Uploads need object storage; everything after the bytes land is database
    // work, and that is what the reshaped listing and patch endpoints do.
    for (let index = 1; index <= 3; index++)
      await sql`insert into site_data_files
        (id, user_id, object_key, original_name, content_type, size_bytes, status, metadata, created_at)
        values (${`file_${index}`}, ${ownerId}, ${`${ownerId}/file_${index}.png`}, ${`file_${index}.png`},
          'image/png', ${index * 100}, 'ready', ${JSON.stringify({
            postId: index === 3 ? "other" : "hello",
          })}::jsonb, now() + ${sql.raw(`interval '${index} seconds'`)})`.execute(
        db,
      );
    const usage = await owner.files.usage();
    expect(usage).toEqual({
      bytes: 600,
      count: 3,
      pending: 0,
      maxBytes: expect.any(Number),
    });
    // Newest first by default, and a page carries a cursor rather than the lot.
    const first = await owner.files.list({ limit: 2 });
    expect(first.files.map((file) => file.id)).toEqual(["file_3", "file_2"]);
    expect(first.nextPageToken).toEqual(expect.any(String));
    const second = await owner.files.list({
      limit: 2,
      pageToken: first.nextPageToken,
    });
    expect(second.files.map((file) => file.id)).toEqual(["file_1"]);
    expect(second.nextPageToken).toBeNull();
    // The server does the finding, so a caller never walks the library to
    // discover which images belong to one post.
    const matched: string[] = [];
    for await (const file of owner.files.all({ where: { postId: "hello" } }))
      matched.push(file.id);
    expect(matched).toEqual(["file_2", "file_1"]);
    await expect(
      owner.files.list({
        where: { postId: "other" },
        pageToken: first.nextPageToken,
      }),
    ).rejects.toMatchObject({ status: 400 });
    const moved = await owner.files.update(
      "file_1",
      { postId: "moved", altText: "비둘기" },
      { ifVersion: 1 },
    );
    expect(moved).toMatchObject({
      id: "file_1",
      version: 2,
      metadata: { postId: "moved", altText: "비둘기" },
    });
    await expect(
      owner.files.update("file_1", { postId: "again" }, { ifVersion: 1 }),
    ).rejects.toMatchObject({ status: 409, code: "VERSION_CONFLICT" });
    expect(
      (await owner.files.update("file_1", {}, { unset: ["altText"] })).metadata,
    ).toEqual({ postId: "moved" });
    await expect(
      publicDb.collection("crud").list({ orderBy: "createdAt" }),
    ).resolves.toBeDefined();
    // The anonymous client has no media surface at all to misuse.
    expect((publicDb as { files?: unknown }).files).toBeUndefined();
  });

  // Public reads are the request a site makes most, and letting a shared cache
  // hold them is the whole reason the SDK stopped forcing no-store. What must
  // never be cacheable is a response that depended on a credential.
  test("only anonymous reads of world collections are marked cacheable", async () => {
    const anonymous = await nativeFetch(`${origin}/api/data/alice/feed`, {
      headers: { Origin: "https://example.test" },
    });
    await anonymous.arrayBuffer();
    expect(anonymous.headers.get("cache-control")).toContain("s-maxage");
    expect(anonymous.headers.get("vary")).toContain("Authorization");

    // Same URL, but with a token: an intermediary that ignores Vary must not be
    // handed something it could replay to a stranger.
    const authorized = await nativeFetch(`${origin}/api/data/alice/feed`, {
      headers: { Origin: origin, Authorization: `Bearer ${accessToken}` },
    });
    await authorized.arrayBuffer();
    expect(authorized.headers.get("cache-control")).toBe("no-store");

    // An admin-only collection is never cacheable, whoever asks.
    const priv = await nativeFetch(`${origin}/api/data/alice/private`, {
      headers: { Origin: origin, Authorization: `Bearer ${accessToken}` },
    });
    await priv.arrayBuffer();
    expect(priv.headers.get("cache-control")).toBe("no-store");

    // Neither is a write, nor an error.
    const written = await nativeFetch(`${origin}/api/data/alice/feed`, {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json" },
      body: JSON.stringify({ data: { cacheable: false } }),
    });
    await written.arrayBuffer();
    expect(written.headers.get("cache-control")).toBe("no-store");
    const missing = await nativeFetch(`${origin}/api/data/alice/nope`, {
      headers: { Origin: "https://example.test" },
    });
    await missing.arrayBuffer();
    expect(missing.status).toBe(404);
    expect(missing.headers.get("cache-control")).toBe("no-store");
  });

  test("walking stops at its ceiling instead of paging without end", async () => {
    const feed = owner.collection("feed");
    for (let index = 0; index < 4; index += 1)
      await feed.set(`walk-${index}`, { index });
    const walked: string[] = [];
    await expect(
      (async () => {
        for await (const document of feed.all({ max: 2, limit: 1 }))
          walked.push(document.id);
      })(),
    ).rejects.toMatchObject({ code: "WALK_LIMIT_EXCEEDED" });
    expect(walked).toHaveLength(2);
    // Raising it deliberately is what the error tells the caller to do.
    const all: string[] = [];
    for await (const document of feed.all({ max: 100 })) all.push(document.id);
    expect(all.length).toBeGreaterThanOrEqual(4);
  });

  test("SDK signout revokes the real owner token", async () => {
    await owner.signOut();
    expect(await publicDb.completeOwnerSignIn()).toBeNull();
    await expect(owner.collection("private").list()).rejects.toMatchObject({
      status: 401,
    });
    const copiedTokenResponse = await nativeFetch(
      `${origin}/api/data/alice/private`,
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
