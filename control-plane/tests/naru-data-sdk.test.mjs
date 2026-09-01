import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createDatabase,
  NaruDataError,
} from "../public/sdk/1.0.0/naru-data.js";

test("SDK sends cross-origin CRUD requests without credentials", async () => {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    return Response.json({
      id: "one",
      document: { id: "one", data: null },
      documents: [],
      nextCursor: null,
    });
  };
  try {
    const entries = createDatabase({
      site: "alice",
      baseUrl: "https://naru.pub/",
    }).collection("guestbook");
    assert.deepEqual(await entries.get("one"), { id: "one", data: null });
    await entries.list({ limit: 2, after: "one" });
    await entries.add({ message: "hi" });
    await entries.set("one", null);
    await entries.delete("one");
    assert.deepEqual(
      calls.map((c) => c.options.method),
      ["GET", "GET", "POST", "PUT", "DELETE"],
    );
    assert.ok(calls.every((c) => c.options.credentials === "omit"));
    assert.equal(
      calls[1].url,
      "https://naru.pub/api/data/alice/guestbook?limit=2&after=one",
    );
    assert.equal(calls[3].options.body, '{"data":null}');
  } finally {
    globalThis.fetch = original;
  }
});

test("owner file upload authorizes, uploads directly, finalizes and exposes metadata", async () => {
  const oldWindow = globalThis.window,
    oldFetch = globalThis.fetch;
  const browser = fakeBrowser();
  globalThis.window = browser;
  const key =
    "naru:owner:https://naru.pub:alice:session:https://alice.example/admin.html";
  browser.storage.set(
    key,
    JSON.stringify({
      accessToken: "t".repeat(43),
      expiresAt: Date.now() + 3600000,
      redirectUri: browser.location.href,
    }),
  );
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), options });
    if (String(url) === "https://upload.example/signed")
      return new Response(null, { status: 200 });
    if (options.method === "POST")
      return Response.json({
        file: { id: "file_one", status: "pending" },
        uploadUrl: "https://upload.example/signed",
        method: "PUT",
        headers: { "Content-Type": "image/png" },
      });
    return Response.json({
      file: {
        id: "file_one",
        name: "upload",
        contentType: "image/png",
        size: 3,
        status: "ready",
        url: "https://media.naru.pub/1/file_one.png",
      },
    });
  };
  try {
    const owner = await createDatabase({ site: "alice" }).completeOwnerSignIn();
    const file = await owner.files.upload(
      new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" }),
    );
    assert.equal(file.url, "https://media.naru.pub/1/file_one.png");
    assert.deepEqual(
      calls.map((call) => [call.url, call.options.method]),
      [
        ["https://naru.pub/api/data/alice/_files", "POST"],
        ["https://upload.example/signed", "PUT"],
        ["https://naru.pub/api/data/alice/_files/file_one", "PUT"],
      ],
    );
    assert.equal(calls[1].options.body.size, 3);
    assert.equal(
      calls[0].options.headers.Authorization,
      `Bearer ${"t".repeat(43)}`,
    );
  } finally {
    globalThis.window = oldWindow;
    globalThis.fetch = oldFetch;
  }
});

test("SDK exposes status codes and rejects unsafe path segments", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () =>
    Response.json({ error: "Permission denied." }, { status: 403 });
  try {
    const entries = createDatabase({
      site: "alice",
      baseUrl: "https://naru.pub",
    }).collection("private");
    await assert.rejects(
      entries.get("one"),
      (e) => e instanceof NaruDataError && e.status === 403,
    );
    await assert.rejects(entries.get("../private"), TypeError);
    assert.throws(() => createDatabase({ site: "../bob" }), TypeError);
  } finally {
    globalThis.fetch = original;
  }
});

function fakeBrowser() {
  const storage = new Map();
  const location = {
    href: "https://alice.example/admin.html",
    origin: "https://alice.example",
    pathname: "/admin.html",
    assign(url) {
      this.href = url;
    },
  };
  return {
    location,
    sessionStorage: {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, value),
      removeItem: (key) => storage.delete(key),
    },
    history: {
      replaceState(_state, _title, url) {
        location.href = url;
      },
    },
    storage,
  };
}

test("owner redirect uses PKCE; callback exchanges once and keeps public calls anonymous", async () => {
  const oldWindow = globalThis.window,
    oldFetch = globalThis.fetch;
  const browser = fakeBrowser();
  globalThis.window = browser;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith("/token"))
      return Response.json({
        accessToken: "t".repeat(43),
        expiresIn: 86400,
        expiresAt: Date.now() + 24 * 3600000,
        tokenType: "Bearer",
      });
    return Response.json({ documents: [], id: "one" });
  };
  try {
    const db = createDatabase({ site: "alice", baseUrl: "https://naru.pub" });
    assert.equal(await db.completeOwnerSignIn(), null);
    await db.signInAsOwner({ clientId: "registered", collections: ["posts"] });
    const authorize = new URL(browser.location.href);
    assert.equal(authorize.origin, "https://naru.pub");
    assert.equal(authorize.pathname, "/database/authorize");
    assert.match(
      authorize.searchParams.get("challenge"),
      /^[A-Za-z0-9_-]{43}$/,
    );
    assert.equal(authorize.searchParams.get("collections"), "posts");
    const saved = JSON.parse([...browser.storage.values()][0]);
    const hash = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(saved.verifier),
    );
    assert.equal(
      Buffer.from(hash).toString("base64url"),
      authorize.searchParams.get("challenge"),
    );
    browser.location.href = `${saved.redirectUri}?code=${"c".repeat(43)}&state=${saved.state}`;
    const admin = await db.completeOwnerSignIn();
    assert.equal(browser.location.href, "https://alice.example/admin.html");
    assert.equal(browser.storage.size, 1);
    assert.equal(
      JSON.parse([...browser.storage.values()][0]).accessToken,
      "t".repeat(43),
    );
    assert.equal(JSON.parse(calls[0].options.body).verifier, saved.verifier);
    await admin.collection("posts").set("one", { title: "hello" });
    assert.equal(
      calls[1].options.headers.Authorization,
      `Bearer ${"t".repeat(43)}`,
    );
    await db.collection("posts").list();
    assert.equal(calls[2].options.headers.Authorization, undefined);
    assert.ok(
      calls.every(
        (call) =>
          call.options.credentials === "omit" &&
          call.options.redirect === "error",
      ),
    );
    await admin.signOut();
    assert.equal(calls[3].url, "https://naru.pub/api/data-auth/revoke");
    assert.equal(browser.storage.size, 0);
    await assert.rejects(
      admin.collection("posts").list(),
      (e) => e.status === 401,
    );
  } finally {
    globalThis.window = oldWindow;
    globalThis.fetch = oldFetch;
  }
});

test("owner sign-in discovers the registered site client when clientId is omitted", async () => {
  const oldWindow = globalThis.window,
    oldFetch = globalThis.fetch;
  const browser = fakeBrowser();
  globalThis.window = browser;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), options });
    return Response.json({ clientId: "discovered-client" });
  };
  try {
    const db = createDatabase({ site: "alice" });
    await db.signInAsOwner({ collections: ["posts"] });
    const discovery = new URL(calls[0].url);
    assert.equal(discovery.pathname, "/api/data-auth/discover");
    assert.equal(discovery.searchParams.get("site"), "alice");
    assert.equal(
      discovery.searchParams.get("redirectUri"),
      "https://alice.example/admin.html",
    );
    assert.equal(
      new URL(browser.location.href).searchParams.get("clientId"),
      "discovered-client",
    );
  } finally {
    globalThis.window = oldWindow;
    globalThis.fetch = oldFetch;
  }
});

test("schemas reject invalid writes and owner batch snapshots valid operations", async () => {
  const oldWindow = globalThis.window,
    oldFetch = globalThis.fetch;
  const browser = fakeBrowser();
  globalThis.window = browser;
  browser.storage.set(
    "naru:owner:https://naru.pub:alice:session:https://alice.example/admin.html",
    JSON.stringify({
      accessToken: "t".repeat(43),
      expiresAt: Date.now() + 3600000,
      redirectUri: browser.location.href,
    }),
  );
  let body;
  globalThis.fetch = async (_url, options) => {
    body = options.body;
    return Response.json({ results: [{ id: "one" }] });
  };
  try {
    const db = createDatabase({
      site: "alice",
      schemas: { posts: (data) => typeof data.title === "string" },
    });
    assert.throws(() => db.collection("posts").set("bad", {}), TypeError);
    const owner = await db.completeOwnerSignIn();
    const data = { title: "hello" };
    await owner.batch([{ type: "set", collection: "posts", id: "one", data }]);
    data.title = "changed";
    assert.equal(JSON.parse(body).operations[0].data.title, "hello");
    await owner.batch([
      {
        type: "update",
        collection: "posts",
        id: "one",
        data: { body: "text" },
        unset: ["legacy"],
        ifVersion: 4,
      },
      { type: "delete", collection: "posts", id: "two", ifVersion: 1 },
    ]);
    assert.deepEqual(JSON.parse(body).operations, [
      {
        collection: "posts",
        id: "one",
        ifVersion: 4,
        type: "update",
        data: { body: "text" },
        unset: ["legacy"],
      },
      { collection: "posts", id: "two", ifVersion: 1, type: "delete" },
    ]);
    for (const operation of [
      { type: "update", collection: "posts", id: "one", data: "text" },
      { type: "update", collection: "posts", id: "one", data: {}, unset: "a" },
      { type: "set", collection: "posts", id: "one", data, ifVersion: -1 },
      { type: "replace", collection: "posts", id: "one", data },
    ])
      assert.throws(() => owner.batch([operation]), TypeError);
    // A patch is a fragment, so the whole-document schema must not judge it.
    assert.doesNotThrow(() =>
      owner.batch([
        { type: "update", collection: "posts", id: "one", data: { body: "x" } },
      ]),
    );
  } finally {
    globalThis.window = oldWindow;
    globalThis.fetch = oldFetch;
  }
});

test("controlPlaneOrigin accepts loopback development only", () => {
  assert.doesNotThrow(() =>
    createDatabase({
      site: "alice",
      controlPlaneOrigin: "http://localhost:3000",
    }),
  );
  assert.throws(
    () =>
      createDatabase({
        site: "alice",
        controlPlaneOrigin: "https://database.example",
      }),
    TypeError,
  );
});

test("owner callback rejects tampering, missing state and denial without token requests", async () => {
  const oldWindow = globalThis.window,
    oldFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    throw new Error("Unexpected token exchange");
  };
  try {
    for (const mode of [
      "wrong-state",
      "missing",
      "expired",
      "wrong-path",
      "denied",
    ]) {
      const browser = fakeBrowser();
      globalThis.window = browser;
      const db = createDatabase({ site: "alice", baseUrl: "https://naru.pub" });
      await db.signInAsOwner({
        clientId: "registered",
        collections: ["posts"],
      });
      const [key, serialized] = [...browser.storage.entries()][0];
      const saved = JSON.parse(serialized);
      if (mode === "missing") browser.storage.clear();
      if (mode === "expired") {
        saved.startedAt -= 600001;
        browser.storage.set(key, JSON.stringify(saved));
      }
      browser.location.href = `${saved.redirectUri}${mode === "wrong-path" ? "/other" : ""}?${mode === "denied" ? "error=access_denied" : "code=code"}&state=${mode === "wrong-state" ? "wrong" : saved.state}`;
      await assert.rejects(
        db.completeOwnerSignIn(),
        (e) =>
          e instanceof NaruDataError &&
          e.status === (mode === "denied" ? 403 : 401),
      );
      assert.ok(!browser.location.href.includes("code="));
    }
    assert.equal(calls, 0);
  } finally {
    globalThis.window = oldWindow;
    globalThis.fetch = oldFetch;
  }
});

test("SDK carries sort options and opaque cursors unchanged", async () => {
  const original = globalThis.fetch,
    urls = [];
  globalThis.fetch = async (url) => {
    urls.push(new URL(url));
    return Response.json({ documents: [], nextCursor: "v1.opaque-cursor" });
  };
  try {
    const posts = createDatabase({
      site: "alice",
      baseUrl: "https://naru.pub",
    }).collection("posts");
    const sort = { orderBy: "created_at", direction: "desc" };
    const first = await posts.list({ ...sort, limit: 20 });
    await posts.list({ ...sort, after: first.nextCursor, limit: 10 });
    assert.equal(urls[1].searchParams.get("orderBy"), "created_at");
    assert.equal(urls[1].searchParams.get("direction"), "desc");
    assert.equal(urls[1].searchParams.get("after"), "v1.opaque-cursor");
    assert.equal(urls[1].searchParams.get("limit"), "10");
  } finally {
    globalThis.fetch = original;
  }
});

test("SDK serializes equality filters and rejects values JSON would silently drop", async () => {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(new URL(url));
    return Response.json({ documents: [], nextCursor: null });
  };
  try {
    const posts = createDatabase({
      site: "alice",
      baseUrl: "https://naru.pub",
    }).collection("posts");
    await posts.list({
      where: { category: "일상", active: false, count: 0, optional: null },
    });
    assert.deepEqual(JSON.parse(calls[0].searchParams.get("where")), {
      category: "일상",
      active: false,
      count: 0,
      optional: null,
    });
    for (const where of [
      null,
      [],
      { category: undefined },
      { count: NaN },
      { count: Infinity },
      { nested: {} },
      { tags: [] },
      { value: () => 1 },
    ])
      assert.throws(() => posts.list({ where }), TypeError);
    assert.equal(calls.length, 1);
  } finally {
    globalThis.fetch = original;
  }
});

test("SDK serializes range filters and rejects unsupported comparisons", async () => {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(new URL(url));
    return Response.json({ documents: [], nextCursor: null });
  };
  try {
    const posts = createDatabase({
      site: "alice",
      baseUrl: "https://naru.pub",
    }).collection("posts");
    const month = { gte: "2026-09-01", lt: "2026-10-01" };
    await posts.list({ where: { categoryId: "a", date: month } });
    assert.deepEqual(JSON.parse(calls[0].searchParams.get("where")), {
      categoryId: "a",
      date: month,
    });
    for (const where of [
      { date: {} },
      { date: { between: "x" } },
      { date: { gte: null } },
      { date: { gte: true } },
      { date: { gte: NaN } },
      { date: { gte: ["a"] } },
      // Bounds of one range must share a type; JSONB orders numbers above strings.
      { date: { gte: "2026-01-01", lte: 3 } },
      // Six predicates: two bounds on each of three fields.
      { a: { gte: 1, lte: 2 }, b: { gte: 1, lte: 2 }, c: { gte: 1, lte: 2 } },
    ])
      assert.throws(() => posts.list({ where }), TypeError);
    assert.equal(calls.length, 1);
  } finally {
    globalThis.fetch = original;
  }
});

test("count queries the server without paging and all() follows cursors", async () => {
  const original = globalThis.fetch;
  const urls = [];
  const pages = [
    { documents: [{ id: "a" }, { id: "b" }], nextCursor: "v1.one" },
    { documents: [{ id: "c" }], nextCursor: null },
  ];
  globalThis.fetch = async (url) => {
    const parsed = new URL(url);
    urls.push(parsed);
    return Response.json(
      parsed.searchParams.get("count") === "1"
        ? { count: 3 }
        : pages[urls.filter((u) => !u.searchParams.has("count")).length - 1],
    );
  };
  try {
    const posts = createDatabase({
      site: "alice",
      baseUrl: "https://naru.pub",
    }).collection("posts");
    const where = { categoryId: "a" };
    assert.equal(await posts.count({ where }), 3);
    assert.equal(urls[0].searchParams.get("count"), "1");
    assert.deepEqual(JSON.parse(urls[0].searchParams.get("where")), where);
    // Counting never sends paging inputs the server would have to ignore.
    assert.equal(urls[0].searchParams.has("limit"), false);
    assert.equal(urls[0].searchParams.has("after"), false);
    const ids = [];
    for await (const document of posts.all({ where, orderBy: "data.date" }))
      ids.push(document.id);
    assert.deepEqual(ids, ["a", "b", "c"]);
    assert.equal(urls[1].searchParams.get("limit"), "100");
    assert.equal(urls[1].searchParams.has("after"), false);
    assert.equal(urls[2].searchParams.get("after"), "v1.one");
    assert.equal(urls[2].searchParams.get("orderBy"), "data.date");
  } finally {
    globalThis.fetch = original;
  }
});

test("all() stops instead of paging forever on a repeated cursor", async () => {
  const original = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async () => {
    requests += 1;
    return Response.json({ documents: [{ id: "a" }], nextCursor: "v1.stuck" });
  };
  try {
    const posts = createDatabase({
      site: "alice",
      baseUrl: "https://naru.pub",
    }).collection("posts");
    const ids = [];
    for await (const document of posts.all()) ids.push(document.id);
    assert.deepEqual(ids, ["a", "a"]);
    assert.equal(requests, 2);
  } finally {
    globalThis.fetch = original;
  }
});

test("merge patches and conditional writes travel as PATCH and ifVersion", async () => {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url: new URL(url), options });
    return Response.json({ id: "one", version: 2 });
  };
  try {
    const posts = createDatabase({
      site: "alice",
      // A schema judges whole documents, so a fragment must not be checked.
      schemas: { posts: (data) => typeof data?.title === "string" },
      baseUrl: "https://naru.pub",
    }).collection("posts");
    await posts.update("one", { body: "text" }, { unset: ["legacy"] });
    assert.equal(calls[0].options.method, "PATCH");
    assert.deepEqual(JSON.parse(calls[0].options.body), {
      data: { body: "text" },
      unset: ["legacy"],
    });
    assert.equal(calls[0].url.searchParams.has("ifVersion"), false);
    await posts.set("one", { title: "x" }, { ifVersion: 3 });
    assert.equal(calls[1].url.searchParams.get("ifVersion"), "3");
    await posts.delete("one", { ifVersion: 0 });
    assert.equal(calls[2].options.method, "DELETE");
    assert.equal(calls[2].url.searchParams.get("ifVersion"), "0");
    // A conditional delete carries no body: intermediaries may drop one.
    assert.equal(calls[2].options.body, undefined);
    for (const bad of [-1, 1.5, "2", null])
      assert.throws(() => posts.set("one", { title: "x" }, { ifVersion: bad }), TypeError);
    for (const patch of ["text", [1], null, undefined])
      assert.throws(() => posts.update("one", patch), TypeError);
    assert.throws(() => posts.update("one", { a: 1 }, { unset: "a" }), TypeError);
    // The whole-document schema still guards set().
    assert.throws(() => posts.set("one", { title: 1 }), TypeError);
    assert.equal(calls.length, 3);
  } finally {
    globalThis.fetch = original;
  }
});

test("SDK pins the control plane even when copied or given an old baseUrl option", async () => {
  const original = globalThis.fetch;
  const urls = [];
  globalThis.fetch = async (url) => {
    urls.push(url);
    return Response.json({ documents: [] });
  };
  try {
    await createDatabase({ site: "alice", baseUrl: "https://evil.example" })
      .collection("posts")
      .list();
    assert.equal(new URL(urls[0]).origin, "https://naru.pub");
  } finally {
    globalThis.fetch = original;
  }
});

test("one token restores after reload without network calls and retains its original deadline", async () => {
  const oldWindow = globalThis.window,
    oldFetch = globalThis.fetch,
    oldNow = Date.now;
  let now = oldNow();
  Date.now = () => now;
  const deadline = now + 24 * 3600000,
    browser = fakeBrowser();
  globalThis.window = browser;
  const key =
    "naru:owner:https://naru.pub:alice:session:https://alice.example/admin.html";
  const saved = {
    accessToken: "t".repeat(43),
    expiresAt: deadline,
    redirectUri: browser.location.href,
  };
  browser.storage.set(key, JSON.stringify(saved));
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    return Response.json({ documents: [] });
  };
  try {
    const owner = await createDatabase({ site: "alice" }).completeOwnerSignIn();
    assert.equal(calls.length, 0);
    now += 12 * 3600000;
    const restored = await createDatabase({
      site: "alice",
    }).completeOwnerSignIn();
    assert.equal(restored.expiresAt, deadline);
    await restored.collection("posts").list();
    assert.equal(
      calls[0].options.headers.Authorization,
      `Bearer ${saved.accessToken}`,
    );
    assert.equal(browser.storage.get(key), JSON.stringify(saved));
    browser.location.pathname = "/other.html";
    browser.location.href = "https://alice.example/other.html";
    assert.equal(
      await createDatabase({ site: "alice" }).completeOwnerSignIn(),
      null,
    );
    browser.location.pathname = "/admin.html";
    browser.location.href = saved.redirectUri;
    now = deadline;
    await assert.rejects(
      restored.collection("posts").list(),
      (e) => e.status === 401,
    );
    assert.equal(browser.storage.size, 0);
    assert.equal(
      await createDatabase({ site: "alice" }).completeOwnerSignIn(),
      null,
    );
  } finally {
    globalThis.window = oldWindow;
    globalThis.fetch = oldFetch;
    Date.now = oldNow;
  }
});

test("revocation clears persisted credentials; logout clears them even offline", async () => {
  const oldWindow = globalThis.window,
    oldFetch = globalThis.fetch;
  const browser = fakeBrowser();
  globalThis.window = browser;
  const key =
    "naru:owner:https://naru.pub:alice:session:https://alice.example/admin.html";
  const saved = {
    accessToken: "t".repeat(43),
    expiresAt: Date.now() + 86400000,
    redirectUri: browser.location.href,
  };
  try {
    browser.storage.set(key, JSON.stringify(saved));
    const owner = await createDatabase({ site: "alice" }).completeOwnerSignIn();
    globalThis.fetch = async () =>
      Response.json({ error: "Revoked" }, { status: 401 });
    await assert.rejects(
      owner.collection("posts").list(),
      (e) => e.status === 401,
    );
    assert.equal(browser.storage.size, 0);
    browser.storage.set(key, JSON.stringify(saved));
    const restored = await createDatabase({
      site: "alice",
    }).completeOwnerSignIn();
    globalThis.fetch = async () => {
      throw new Error("Offline");
    };
    await assert.rejects(
      restored.signOut(),
      (e) =>
        e instanceof NaruDataError &&
        e.status === 0 &&
        e.cause.message === "Offline",
    );
    assert.equal(browser.storage.size, 0);
    await assert.rejects(
      restored.collection("posts").list(),
      (e) => e.status === 401,
    );
  } finally {
    globalThis.window = oldWindow;
    globalThis.fetch = oldFetch;
  }
});

test("non-JSON HTTP errors preserve status; network failures are distinct", async () => {
  const original = globalThis.fetch;
  const entries = createDatabase({ site: "alice" }).collection("posts");
  try {
    for (const [status, body] of [
      [502, "<html>proxy error</html>"],
      [401, ""],
      [429, "null"],
      [200, "broken JSON"],
      [200, "null"],
    ]) {
      globalThis.fetch = async () => new Response(body, { status });
      await assert.rejects(
        entries.get("one"),
        (e) =>
          e instanceof NaruDataError &&
          e.status === status &&
          !e.message.includes("<html>"),
      );
    }
    const cause = new TypeError("Failed to fetch");
    globalThis.fetch = async () => {
      throw cause;
    };
    await assert.rejects(
      entries.get("one"),
      (e) => e.status === 0 && e.cause === cause,
    );
  } finally {
    globalThis.fetch = original;
  }
});

test("writes reject lossy JSON without requests and snapshot valid shared references", async () => {
  const original = globalThis.fetch;
  const bodies = [];
  globalThis.fetch = async (_url, options) => {
    bodies.push(JSON.parse(options.body));
    return Response.json({ id: "one" });
  };
  const entries = createDatabase({ site: "alice" }).collection("posts");
  const cyclic = {};
  cyclic.self = cyclic;
  let getterCalled = false;
  const getter = {
    get x() {
      getterCalled = true;
      return 1;
    },
  };
  try {
    for (const value of [
      undefined,
      NaN,
      Infinity,
      { a: undefined },
      [undefined],
      Array(1),
      1n,
      () => 1,
      Symbol(),
      new Date(),
      new Map(),
      cyclic,
      getter,
      { [Symbol()]: 1 },
    ]) {
      assert.throws(() => entries.add(value), TypeError);
      assert.throws(() => entries.set("one", value), TypeError);
    }
    assert.equal(getterCalled, false);
    assert.equal(bodies.length, 0);
    const shared = { title: "before", count: 0, active: false, optional: null };
    const pending = entries.add({ a: shared, b: shared });
    shared.title = "after";
    await pending;
    assert.equal(bodies[0].data.a.title, "before");
    assert.deepEqual(bodies[0].data.a, bodies[0].data.b);
    await entries.set("one", null);
    assert.equal(bodies[1].data, null);
  } finally {
    globalThis.fetch = original;
  }
});

test("storage denial does not mask revocation or prevent remote logout", async () => {
  const oldWindow = globalThis.window,
    oldFetch = globalThis.fetch;
  const key =
    "naru:owner:https://naru.pub:alice:session:https://alice.example/admin.html";
  try {
    for (const action of ["logout", "unauthorized"]) {
      const browser = fakeBrowser();
      globalThis.window = browser;
      browser.storage.set(
        key,
        JSON.stringify({
          accessToken: "t".repeat(43),
          expiresAt: Date.now() + 60000,
          redirectUri: browser.location.href,
        }),
      );
      const db = createDatabase({ site: "alice" });
      const admin = await db.completeOwnerSignIn();
      browser.sessionStorage.getItem = browser.sessionStorage.removeItem =
        () => {
          throw new DOMException("Storage denied", "SecurityError");
        };
      const calls = [];
      globalThis.fetch = async (url) => {
        calls.push(url);
        return action === "logout"
          ? Response.json({ success: true })
          : new Response("Unauthorized", { status: 401 });
      };
      if (action === "logout") {
        await admin.signOut();
        assert.ok(calls[0].endsWith("/revoke"));
      } else
        await assert.rejects(
          admin.collection("posts").get("one"),
          (e) => e.status === 401,
        );
      await assert.rejects(
        admin.collection("posts").get("one"),
        (e) => e.status === 401,
      );
      assert.equal(calls.length, 1);
      assert.equal(await db.completeOwnerSignIn(), null);
    }
  } finally {
    globalThis.window = oldWindow;
    globalThis.fetch = oldFetch;
  }
});

test("failed token persistence revokes the new token and concurrent completions exchange once", async () => {
  const oldWindow = globalThis.window,
    oldFetch = globalThis.fetch;
  try {
    const browser = fakeBrowser();
    globalThis.window = browser;
    const db = createDatabase({ site: "alice" });
    await db.signInAsOwner({ clientId: "registered", collections: ["posts"] });
    const pending = JSON.parse([...browser.storage.values()][0]);
    browser.location.href = `${pending.redirectUri}?code=code&state=${pending.state}`;
    browser.sessionStorage.setItem = () => {
      throw new DOMException("Full", "QuotaExceededError");
    };
    const calls = [];
    globalThis.fetch = async (url) => {
      calls.push(url);
      return Response.json(
        url.endsWith("/token")
          ? {
              accessToken: "t".repeat(43),
              tokenType: "Bearer",
              expiresIn: 60,
              expiresAt: Date.now() + 60000,
            }
          : { success: true },
      );
    };
    const first = db.completeOwnerSignIn(),
      second = db.completeOwnerSignIn();
    assert.equal(first, second);
    await assert.rejects(first, { name: "QuotaExceededError" });
    assert.deepEqual(
      calls.map((url) => new URL(url).pathname),
      ["/api/data-auth/token", "/api/data-auth/revoke"],
    );
    assert.equal(browser.storage.size, 0);
    assert.equal(await db.completeOwnerSignIn(), null);
  } finally {
    globalThis.window = oldWindow;
    globalThis.fetch = oldFetch;
  }
});
