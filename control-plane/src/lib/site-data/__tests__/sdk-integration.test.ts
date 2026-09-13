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
  registerClient,
  siteClientId,
} from "../owner-auth";
import { setupTestDatabase, teardownTestDatabase } from "./test-database";
import {
  collection,
  ownerSession,
  type Owner,
  type SiteOptions,
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
  let owner: Owner;
  let ownerId: number;
  let site: SiteOptions;
  const storage = new Map<string, string>();
  const nativeFetch = globalThis.fetch;
  const browserGlobals = ["location", "sessionStorage", "history"] as const;
  const oldGlobals = browserGlobals.map((name) =>
    Object.getOwnPropertyDescriptor(globalThis, name),
  );
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
    ownerId = userId;
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
    const sessionKey = `naru:owner:${origin}:alice:${redirectUri}`;
    storage.set(
      `${sessionKey}:pending`,
      JSON.stringify({
        clientId,
        verifier,
        state: "s".repeat(43),
        startedAt: Date.now(),
      }),
    );
    // controlPlaneOrigin is a test-only hook, left out of the public types.
    site = { site: "alice", controlPlaneOrigin: origin } as SiteOptions;
    owner = (await ownerSession(site))!;
    expect(location.href).toBe(redirectUri);
    accessToken = JSON.parse(storage.get(sessionKey)!).accessToken;
  }, 30000);

  afterAll(async () => {
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
      if (oldFeatureMode === undefined) delete process.env.FEATURE_ACCESS_MODE;
      else process.env.FEATURE_ACCESS_MODE = oldFeatureMode;
    }
  });

  test("CRUD preserves JSON, metadata, versions, and HTTP failures", async () => {
    const posts = collection("crud", site);
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
    await expect(
      posts.delete(added.id, { ifVersion: 1 }),
    ).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
    expect(await posts.delete(added.id, { ifVersion: 2 })).toBeUndefined();
    await expect(posts.get(added.id)).rejects.toMatchObject({ status: 404 });
    await posts.delete(added.id);
    // Partial updates are not part of the contract.
    const patch = await nativeFetch(`${origin}/api/data/alice/crud/new`, {
      method: "PATCH",
      headers: { Origin: origin, "Content-Type": "application/json" },
      body: JSON.stringify({ data: { a: 1 } }),
    });
    await patch.arrayBuffer();
    expect(patch.status).toBe(405);
    await posts.set("new", null, { ifVersion: 0 });
    await expect(
      posts.set("new", false, { ifVersion: 0 }),
    ).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
  });

  test("filtered pages and totals use the same real query contract", async () => {
    const feed = collection<{ rank: number; visible: boolean }>("feed", site);
    for (let rank = 1; rank <= 5; rank++)
      await feed.set(`post_${rank}`, { rank, visible: rank !== 3 });
    const query = {
      where: { rank: { gte: 2 }, visible: true },
      orderBy: [["data.rank", "desc"]] as [[string, "desc"]],
    };
    const first = await feed.list({ ...query, limit: 2, includeTotal: true });
    expect(first.total).toBe(3);
    expect(first.documents.map((d) => d.id)).toEqual(["post_5", "post_4"]);
    expect(first.nextPageToken).toEqual(expect.any(String));
    const second = await feed.list({
      ...query,
      limit: 2,
      pageToken: first.nextPageToken,
    });
    expect(second.documents.map((d) => d.id)).toEqual(["post_2"]);
    expect(second.nextPageToken).toBeNull();
    await expect(
      feed.list({
        ...query,
        where: { visible: false },
        pageToken: first.nextPageToken,
      }),
    ).rejects.toMatchObject({ status: 400 });
    // An empty filter and a null token are the first, unfiltered page.
    const everything = await feed.list({
      where: {},
      pageToken: null,
      includeTotal: true,
    });
    expect(everything.total).toBe(5);
  });

  test("owner batches return operation results and roll back conflicts across collections", async () => {
    await expect(collection("private", site).list()).rejects.toMatchObject({
      status: 403,
    });
    const results = await owner.batch([
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
    expect(results).toEqual([
      { id: "one", ...stamps },
      { id: expect.any(String), ...stamps },
      { success: true },
    ]);
    const privateId = (results[1] as { id: string }).id;
    await expect(
      owner.batch([
        {
          type: "set",
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

  test("the media library pages newest first", async () => {
    // Uploads need object storage; everything after the bytes land is database
    // work, and that is what the listing does.
    for (let index = 1; index <= 3; index++)
      await sql`insert into site_data_files
        (id, user_id, object_key, original_name, content_type, size_bytes, status, created_at)
        values (${`file_${index}`}, ${ownerId}, ${`${ownerId}/file_${index}.png`}, ${`file_${index}.png`},
          'image/png', ${index * 100}, 'ready', now() + ${sql.raw(`interval '${index} seconds'`)})`.execute(
        db,
      );
    const first = await owner.files.list({ limit: 2 });
    expect(first.files.map((file) => file.id)).toEqual(["file_3", "file_2"]);
    expect(Object.keys(first.files[0]).sort()).toEqual([
      "contentType",
      "createdAt",
      "id",
      "name",
      "size",
      "updatedAt",
      "url",
    ]);
    const second = await owner.files.list({
      limit: 2,
      pageToken: first.nextPageToken,
    });
    expect(second.files.map((file) => file.id)).toEqual(["file_1"]);
    expect(second.nextPageToken).toBeNull();
    // Filtering by what a file belongs to is refused, never ignored: an old
    // page that deletes "this post's files" must not get every file back.
    await expect(
      (owner.files.list as (options: object) => Promise<unknown>)({
        where: { postId: "hello" },
      }),
    ).rejects.toMatchObject({ status: 400 });
    // The quota readout is the control panel's alone.
    const usage = await nativeFetch(`${origin}/api/data/alice/_files?usage=1`, {
      headers: { Origin: origin, Authorization: `Bearer ${accessToken}` },
    });
    expect(await usage.json()).not.toHaveProperty("usage");
    // Uploads carry no metadata to find them by.
    const authorized = await nativeFetch(`${origin}/api/data/alice/_files`, {
      method: "POST",
      headers: {
        Origin: origin,
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: "a.png",
        contentType: "image/png",
        size: 1,
        metadata: { postId: "hello" },
      }),
    }).catch(() => null);
    if (authorized?.ok) {
      const body = await authorized.json();
      expect(Object.keys(body).sort()).toEqual(["headers", "id", "uploadUrl"]);
      const stored = await sql<{
        metadata: unknown;
      }>`select metadata from site_data_files where id = ${body.id}`.execute(
        db,
      );
      expect(stored.rows[0].metadata).toEqual({});
    }
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

  test("SDK signout revokes the real owner token", async () => {
    await owner.signOut();
    expect(await ownerSession(site)).toBeNull();
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
