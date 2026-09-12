import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createRequestChannel,
  createDatabase,
  NaruDataError,
} from "../public/sdk/1.0.0/naru-data.js";

test("request channels cancel the previous request and normalize through the SDK", () => {
  const channel = createRequestChannel();
  const first = channel.next();
  const second = channel.next();
  assert.equal(first.aborted, true);
  assert.equal(second.aborted, false);
  channel.cancel();
  assert.equal(second.aborted, true);
});

const writtenFixture = (id = "one", version = 1) => ({
  id,
  version,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});
const documentFixture = (id, data = null) => ({
  ...writtenFixture(id),
  data,
});

test("SDK sends cross-origin CRUD requests without credentials", async () => {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    return Response.json({
      ...writtenFixture(),
      success: true,
      document: documentFixture("one"),
      documents: [],
      nextPageToken: null,
    });
  };
  try {
    const entries = createDatabase({
      site: "alice",
      baseUrl: "https://naru.pub/",
    }).collection("guestbook");
    assert.deepEqual(await entries.get("one"), documentFixture("one"));
    await entries.list({ limit: 2, pageToken: "one" });
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
      "https://naru.pub/api/data/alice/guestbook?limit=2&pageToken=one",
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
        metadata: {},
        version: 1,
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
        url: "https://media.naru.pub/1/file_one.png",
      },
    });
  };
  try {
    const owner = await createDatabase({ site: "alice" }).completeOwnerSignIn();
    const file = await owner.files.upload(
      new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" }),
      { metadata: { postId: "hello" } },
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
    assert.deepEqual(JSON.parse(calls[0].options.body).metadata, {
      postId: "hello",
    });
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
  // A real Location derives origin and pathname from href. Holding them as
  // fixed strings would let a test navigate somewhere the SDK could not see.
  let href = "https://alice.example/admin.html";
  const location = {
    get href() {
      return href;
    },
    set href(value) {
      href = value;
    },
    get origin() {
      return new URL(href).origin;
    },
    get pathname() {
      return new URL(href).pathname;
    },
    assign(url) {
      href = url;
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
    return Response.json({
      documents: [],
      nextPageToken: null,
      ...writtenFixture(),
    });
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

test("parsers reject invalid writes and owner batch snapshots valid operations", async () => {
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
    return Response.json({
      results: JSON.parse(body).operations.map((op) =>
        op.type === "delete"
          ? { success: true }
          : writtenFixture(op.id ?? "one"),
      ),
    });
  };
  try {
    const db = createDatabase({
      site: "alice",
      collections: { posts: { parse: titled } },
    });
    assert.throws(() => db.collection("posts").set("bad", {}), TypeError);
    const owner = await db.completeOwnerSignIn();
    const data = { title: "hello" };
    await owner.batch([{ type: "set", collection: "posts", id: "one", data }]);
    data.title = "changed";
    assert.equal(JSON.parse(body).operations[0].data.title, "hello");
    assert.throws(
      () =>
        owner.batch([
          { type: "set", collection: "posts", id: "one", data: {} },
        ]),
      TypeError,
    );
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
    await owner.batch([
      { type: "add", collection: "posts", data: { title: "fresh" } },
    ]);
    // add carries no ID: the server assigns one.
    assert.deepEqual(JSON.parse(body).operations, [
      { type: "add", collection: "posts", data: { title: "fresh" } },
    ]);
    for (const operation of [
      { type: "add", collection: "posts", id: "one", data },
      { type: "add", collection: "posts", data, ifVersion: 0 },
      { type: "update", collection: "posts", id: "one", data: "text" },
      { type: "update", collection: "posts", id: "one", data: {}, unset: "a" },
      { type: "set", collection: "posts", id: "one", data, ifVersion: -1 },
      { type: "replace", collection: "posts", id: "one", data },
    ])
      assert.throws(() => owner.batch([operation]), TypeError);
    // A patch is a fragment, so the whole-document parser must not judge it.
    await owner.batch([
      { type: "update", collection: "posts", id: "one", data: { body: "x" } },
    ]);
  } finally {
    globalThis.window = oldWindow;
    globalThis.fetch = oldFetch;
  }
});

function titled(data) {
  if (typeof data?.title !== "string")
    throw new TypeError("title must be a string");
  return data;
}

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
    return Response.json({ documents: [], nextPageToken: "v1.opaque-cursor" });
  };
  try {
    const posts = createDatabase({
      site: "alice",
      baseUrl: "https://naru.pub",
    }).collection("posts");
    const sort = { orderBy: "createdAt", direction: "desc" };
    const first = await posts.list({ ...sort, limit: 20 });
    await posts.list({ ...sort, pageToken: first.nextPageToken, limit: 10 });
    assert.equal(urls[1].searchParams.get("orderBy"), "createdAt");
    assert.equal(urls[1].searchParams.get("direction"), "desc");
    assert.equal(urls[1].searchParams.get("pageToken"), "v1.opaque-cursor");
    assert.equal(urls[1].searchParams.get("limit"), "10");
  } finally {
    globalThis.fetch = original;
  }
});

test("multi-field ordering and totals use one page request", async () => {
  const original = globalThis.fetch,
    urls = [];
  globalThis.fetch = async (url) => {
    urls.push(new URL(url));
    return Response.json({
      documents: [],
      nextPageToken: "v2.page",
      total: 12,
    });
  };
  try {
    const posts = createDatabase({ site: "alice" }).collection("posts");
    const page = await posts.list({
      orderBy: [
        ["data.date", "desc"],
        ["createdAt", "desc"],
      ],
      includeTotal: true,
    });
    assert.equal(page.total, 12);
    assert.equal(page.nextPageToken, "v2.page");
    assert.deepEqual(JSON.parse(urls[0].searchParams.get("orderBy")), [
      ["data.date", "desc"],
      ["createdAt", "desc"],
    ]);
    assert.equal(urls[0].searchParams.get("includeTotal"), "1");
    assert.throws(
      () =>
        posts.list({
          orderBy: [["data.date", "desc"]],
          direction: "desc",
        }),
      TypeError,
    );
  } finally {
    globalThis.fetch = original;
  }
});

test("SDK serializes equality filters and rejects values JSON would silently drop", async () => {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(new URL(url));
    return Response.json({ documents: [], nextPageToken: null });
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
    return Response.json({ documents: [], nextPageToken: null });
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
      { date: { gte: null } },
      { date: { gte: true } },
      { date: { gte: NaN } },
      { date: { gte: ["a"] } },
      // Bounds of one range must share a type; JSONB orders numbers above strings.
      { date: { gte: "2026-01-01", lte: 3 } },
    ])
      assert.throws(() => posts.list({ where }), TypeError);
    assert.equal(calls.length, 1);
    // An operator this version does not know, and more predicates than the
    // server accepts today, are both sent rather than refused here. This file
    // is versioned: a client frozen with a closed operator list could never use
    // a filter the server learns later, so the server does the refusing and
    // says so. Only shapes that could not be a filter at all fail locally.
    await posts.list({ where: { date: { between: "x" } } });
    assert.deepEqual(JSON.parse(calls[1].searchParams.get("where")), {
      date: { between: "x" },
    });
    await posts.list({
      where: {
        a: { gte: 1, lte: 2 },
        b: { gte: 1, lte: 2 },
        c: { gte: 1, lte: 2 },
      },
    });
    assert.equal(calls.length, 3);
    // An empty filter is no filter, not a malformed one.
    await posts.list({ where: {} });
    assert.equal(calls.length, 4);
    assert.equal(calls[3].searchParams.has("where"), false);
  } finally {
    globalThis.fetch = original;
  }
});

test("count queries the server without paging and all() follows cursors", async () => {
  const original = globalThis.fetch;
  const urls = [];
  const pages = [
    {
      documents: [documentFixture("a"), documentFixture("b")],
      nextPageToken: "v1.one",
    },
    { documents: [documentFixture("c")], nextPageToken: null },
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
    assert.equal(urls[0].searchParams.has("pageToken"), false);
    const ids = [];
    for await (const document of posts.all({ where, orderBy: "data.date" }))
      ids.push(document.id);
    assert.deepEqual(ids, ["a", "b", "c"]);
    assert.equal(urls[1].searchParams.get("limit"), "100");
    assert.equal(urls[1].searchParams.has("pageToken"), false);
    assert.equal(urls[2].searchParams.get("pageToken"), "v1.one");
    assert.equal(urls[2].searchParams.get("orderBy"), "data.date");
  } finally {
    globalThis.fetch = original;
  }
});

test("all() rejects a repeated cursor before yielding the repeated page", async () => {
  const original = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async () => {
    requests += 1;
    return Response.json({
      documents: [documentFixture("a")],
      nextPageToken: "v1.stuck",
    });
  };
  try {
    const posts = createDatabase({
      site: "alice",
      baseUrl: "https://naru.pub",
    }).collection("posts");
    const ids = [];
    await assert.rejects(
      async () => {
        for await (const document of posts.all()) ids.push(document.id);
      },
      { code: "INVALID_PAGINATION" },
    );
    assert.deepEqual(ids, ["a"]);
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
    return Response.json(
      options.method === "DELETE"
        ? { success: true }
        : writtenFixture("one", 2),
    );
  };
  try {
    const posts = createDatabase({
      site: "alice",
      // A parser judges whole documents, so a fragment must not be checked.
      collections: { posts: { parse: titled } },
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
      assert.throws(
        () => posts.set("one", { title: "x" }, { ifVersion: bad }),
        TypeError,
      );
    for (const patch of ["text", [1], null, undefined])
      assert.throws(() => posts.update("one", patch), TypeError);
    assert.throws(
      () => posts.update("one", { a: 1 }, { unset: "a" }),
      TypeError,
    );
    // The whole-document parser still guards set().
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
    return Response.json({ documents: [], nextPageToken: null });
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
    return Response.json({ documents: [], nextPageToken: null });
  };
  try {
    const owner = await createDatabase({ site: "alice" }).completeOwnerSignIn();
    assert.equal(calls.length, 0);
    now += 12 * 3600000;
    const restored = await createDatabase({
      site: "alice",
    }).completeOwnerSignIn();
    assert.equal(restored.session.expiresAt, deadline);
    assert.equal(restored.expiresAt, undefined);
    await restored.collection("posts").list();
    assert.equal(
      calls[0].options.headers.Authorization,
      `Bearer ${saved.accessToken}`,
    );
    assert.equal(browser.storage.get(key), JSON.stringify(saved));
    browser.location.href = "https://alice.example/other.html";
    assert.equal(
      await createDatabase({ site: "alice" }).completeOwnerSignIn(),
      null,
    );
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
    const states = [];
    const unsubscribe = owner.onSessionChange((session) =>
      states.push(session.status),
    );
    assert.deepEqual(states, ["active"]);
    globalThis.fetch = async () =>
      Response.json({ error: "Revoked" }, { status: 401 });
    await assert.rejects(
      owner.collection("posts").list(),
      (e) => e.status === 401,
    );
    assert.equal(owner.session.status, "expired");
    assert.deepEqual(states, ["active", "expired"]);
    unsubscribe();
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
    assert.equal(restored.session.status, "signed-out");
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

test("owner writes automatically make same-instance public reads fresh", async () => {
  const oldWindow = globalThis.window,
    oldFetch = globalThis.fetch;
  try {
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
    const calls = [];
    globalThis.fetch = async (url, options) => {
      calls.push({ url: new URL(url), options });
      return options.method === "GET"
        ? Response.json({ documents: [], nextPageToken: null })
        : Response.json(writtenFixture());
    };
    const db = createDatabase({ site: "alice" });
    const owner = await db.completeOwnerSignIn();
    await db.collection("posts").list();
    await owner.collection("posts").set("one", {});
    await db.collection("posts").list();
    await db.collection("categories").list();
    assert.equal(calls[0].options.cache, "default");
    assert.equal(calls[2].options.cache, "no-store");
    assert.equal(calls[3].options.cache, "default");
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

test("query options fail locally instead of making malformed requests", async () => {
  const original = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async () => {
    requests += 1;
    return Response.json({ documents: [], nextPageToken: null });
  };
  try {
    const posts = createDatabase({ site: "alice" }).collection("posts");
    for (const options of [
      { limit: 0 },
      { limit: 1.5 },
      { limit: -1 },
      { pageToken: "" },
      { direction: "sideways" },
      { orderBy: "data.author.name" },
    ])
      assert.throws(() => posts.list(options), TypeError);
    await assert.rejects(posts.count({ direction: "sideways" }), TypeError);
    assert.equal(requests, 0);
    // A page larger than the server currently allows is the server's to refuse.
    // Freezing today's ceiling into the client would mean this SDK could never
    // ask for a bigger page even after the server started allowing one.
    await posts.list({ limit: 101 });
    assert.equal(requests, 1);
  } finally {
    globalThis.fetch = original;
  }
});

test("writes reject lossy JSON without requests and snapshot valid shared references", async () => {
  const original = globalThis.fetch;
  const bodies = [];
  globalThis.fetch = async (_url, options) => {
    bodies.push(JSON.parse(options.body));
    return Response.json(writtenFixture());
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

function restoreTestOwner() {
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
  return createDatabase({ site: "alice" }).completeOwnerSignIn();
}
const uploadAuthorization = () => ({
  file: { id: "file_one", status: "pending" },
  uploadUrl: "https://upload.example/signed",
  method: "PUT",
  headers: { "Content-Type": "image/png" },
});
const storedFileFixture = () => ({
  id: "file_one",
  name: "upload",
  contentType: "image/png",
  size: 3,
  status: "ready",
  metadata: {},
  version: 1,
  url: "https://media.naru.pub/1/file_one.png",
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
});
const untilAborted = (signal) =>
  new Promise((_, reject) => {
    if (signal.aborted) reject(signal.reason);
    else
      signal.addEventListener("abort", () => reject(signal.reason), {
        once: true,
      });
  });

test("every data operation forwards cancellation and rejects before a request when already aborted", async () => {
  const oldFetch = globalThis.fetch,
    oldWindow = globalThis.window;
  try {
    const owner = await restoreTestOwner();
    const posts = owner.collection("posts");
    const operations = [
      (options) => posts.get("one", options),
      (options) => posts.list(options),
      (options) => posts.count(options),
      (options) => posts.all(options).next(),
      (options) => posts.add({}, options),
      (options) => posts.set("one", {}, options),
      (options) => posts.update("one", {}, options),
      (options) => posts.delete("one", options),
      (options) =>
        owner.batch(
          [{ type: "delete", collection: "posts", id: "one" }],
          options,
        ),
      (options) => owner.files.get("one", options),
      (options) => owner.files.list(options),
      (options) => owner.files.usage(options),
      (options) => owner.files.delete("one", options),
    ];
    let calls = 0;
    for (const operation of operations) {
      const controller = new AbortController();
      globalThis.fetch = (_url, options) => {
        calls++;
        const promise = untilAborted(options.signal);
        controller.abort("cancelled by caller");
        return promise;
      };
      await assert.rejects(
        operation({ signal: controller.signal }),
        (error) =>
          error.code === "REQUEST_ABORTED" &&
          error.status === 0 &&
          error.cause === "cancelled by caller",
      );
      const before = calls;
      await assert.rejects(operation({ signal: controller.signal }), {
        code: "REQUEST_ABORTED",
      });
      assert.equal(calls, before);
    }
    assert.equal(calls, operations.length);
  } finally {
    globalThis.fetch = oldFetch;
    globalThis.window = oldWindow;
  }
});

test("timeouts include response body reads, validate options, and release caller listeners", async () => {
  const oldFetch = globalThis.fetch;
  try {
    const posts = createDatabase({ site: "alice" }).collection("posts");
    for (const bodyStalls of [false, true]) {
      globalThis.fetch = async (_url, { signal }) =>
        bodyStalls
          ? { status: 200, ok: true, json: () => untilAborted(signal) }
          : untilAborted(signal);
      await assert.rejects(posts.get("one", { timeoutMs: 5 }), {
        code: "REQUEST_TIMEOUT",
        status: 0,
      });
    }
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      return Response.json({ document: documentFixture("one") });
    };
    for (const timeoutMs of [-1, NaN, Infinity, 0.1, "10", 2147483648])
      await assert.rejects(posts.get("one", { timeoutMs }), TypeError);
    await assert.rejects(posts.get("one", { signal: {} }), TypeError);
    assert.equal(calls, 0);
    const signal = new AbortController().signal;
    let listeners = 0;
    const add = signal.addEventListener.bind(signal),
      remove = signal.removeEventListener.bind(signal);
    signal.addEventListener = (...args) => {
      listeners++;
      return add(...args);
    };
    signal.removeEventListener = (...args) => {
      listeners--;
      return remove(...args);
    };
    await posts.get("one", { signal, timeoutMs: 0 });
    assert.equal(listeners, 0);
    globalThis.fetch = async () => {
      throw new TypeError("offline");
    };
    await assert.rejects(posts.get("one", { signal }), {
      code: "REQUEST_FAILED",
    });
    assert.equal(listeners, 0);
  } finally {
    globalThis.fetch = oldFetch;
  }
});

test("malformed successful envelopes reject instead of returning values outside the declared types", async () => {
  const oldFetch = globalThis.fetch,
    oldWindow = globalThis.window;
  try {
    const owner = await restoreTestOwner(),
      posts = owner.collection("posts");
    const cases = [
      [() => posts.get("one"), {}],
      [
        () => posts.get("one"),
        { document: { ...documentFixture("one"), version: "1" } },
      ],
      [() => posts.list(), { documents: [] }],
      [() => posts.list(), { documents: [{}], nextPageToken: null }],
      [() => posts.list(), { documents: [], nextPageToken: 7 }],
      [() => posts.count(), { count: -1 }],
      [() => posts.add({}), { id: "one" }],
      [() => posts.set("one", {}), { id: "one", version: 0 }],
      [() => posts.update("one", {}), {}],
      [() => posts.delete("one"), { success: false }],
      [
        () => owner.batch([{ type: "delete", collection: "posts", id: "one" }]),
        { results: [] },
      ],
      [
        () => owner.batch([{ type: "add", collection: "posts", data: {} }]),
        { results: [{ success: true }] },
      ],
      [
        () => owner.files.get("one"),
        { file: { ...storedFileFixture(), status: "pending" } },
      ],
      // The pre-cursor listing shape is not a page and is not accepted.
      [() => owner.files.list(), { files: [], usage: {} }],
      [() => owner.files.list(), { files: [{}], nextPageToken: null }],
      [() => owner.files.list(), { files: [], nextPageToken: 7 }],
      [() => owner.files.usage(), { usage: { bytes: -1 } }],
      [() => owner.files.update("one", {}), { file: null }],
      [() => owner.files.delete("one"), {}],
      [
        () => owner.files.upload(new Blob(["abc"])),
        { ...uploadAuthorization(), uploadUrl: "javascript:alert(1)" },
      ],
    ];
    for (const [call, body] of cases) {
      globalThis.fetch = async () => Response.json(body);
      await assert.rejects(call(), { code: "INVALID_RESPONSE", status: 200 });
    }
  } finally {
    globalThis.fetch = oldFetch;
    globalThis.window = oldWindow;
  }
});

test("all rejects longer cursor cycles and honours cancellation within a page", async () => {
  const oldFetch = globalThis.fetch;
  try {
    let calls = 0;
    globalThis.fetch = async () =>
      Response.json({
        documents: [documentFixture("one")],
        nextPageToken: ["a", "b", "a"][calls++],
      });
    const posts = createDatabase({ site: "alice" }).collection("posts");
    await assert.rejects(
      async () => {
        for await (const _ of posts.all()) {
          /* consume */
        }
      },
      { code: "INVALID_PAGINATION" },
    );
    assert.equal(calls, 3);
    const controller = new AbortController();
    globalThis.fetch = async () =>
      Response.json({
        documents: [documentFixture("one"), documentFixture("two")],
        nextPageToken: null,
      });
    const iterator = posts.all({ signal: controller.signal });
    assert.equal((await iterator.next()).value.id, "one");
    controller.abort();
    await assert.rejects(iterator.next(), { code: "REQUEST_ABORTED" });
  } finally {
    globalThis.fetch = oldFetch;
  }
});

test("upload failures at transfer or finalization await independent cleanup and expose cleanup failures", async () => {
  const oldFetch = globalThis.fetch,
    oldWindow = globalThis.window;
  try {
    const owner = await restoreTestOwner();
    for (const stage of [
      "transfer",
      "finalize",
      "malformed-finalize",
      "abort",
      "timeout",
      "cleanup-fails",
    ]) {
      const controller = new AbortController();
      let cleaned = false;
      const calls = [];
      globalThis.fetch = async (url, options) => {
        calls.push([String(url), options.method]);
        if (options.method === "POST")
          return Response.json(uploadAuthorization());
        if (options.method === "DELETE") {
          assert.equal(options.signal.aborted, false);
          await new Promise((resolve) => setTimeout(resolve, 2));
          if (stage === "cleanup-fails") throw new TypeError("cleanup offline");
          cleaned = true;
          return Response.json({ success: true });
        }
        if (String(url).startsWith("https://upload.example")) {
          if (stage === "abort") {
            controller.abort();
            return untilAborted(options.signal);
          }
          if (stage === "timeout") return untilAborted(options.signal);
          if (stage === "transfer" || stage === "cleanup-fails")
            throw new TypeError("transfer offline");
          return new Response(null, { status: 200 });
        }
        return stage === "malformed-finalize"
          ? Response.json({})
          : Response.json({ error: "finalization failed" }, { status: 409 });
      };
      await assert.rejects(
        owner.files.upload(new Blob(["abc"]), {
          signal: controller.signal,
          timeoutMs: stage === "timeout" ? 5 : 1000,
        }),
        (error) => {
          assert.equal(error.fileId, "file_one");
          assert.equal(cleaned, stage !== "cleanup-fails");
          assert.equal(Boolean(error.cleanupError), stage === "cleanup-fails");
          if (stage === "abort") assert.equal(error.code, "REQUEST_ABORTED");
          if (stage === "timeout") assert.equal(error.code, "REQUEST_TIMEOUT");
          return true;
        },
      );
      assert.equal(calls.at(-1)[1], "DELETE");
    }
  } finally {
    globalThis.fetch = oldFetch;
    globalThis.window = oldWindow;
  }
});

test("XHR upload checks cancellation before send and removes transfer listeners after success or failure", async () => {
  const oldFetch = globalThis.fetch,
    oldWindow = globalThis.window,
    oldXHR = globalThis.XMLHttpRequest;
  try {
    const owner = await restoreTestOwner();
    for (const mode of [
      "before-send",
      "during-send",
      "success",
      "progress-throws",
      "send-throws",
    ]) {
      const controller = new AbortController();
      let sent = false,
        cleaned = false,
        xhr;
      globalThis.XMLHttpRequest = class {
        constructor() {
          xhr = this;
          this.upload = {};
          if (mode === "before-send") controller.abort();
        }
        open() {}
        setRequestHeader() {}
        abort() {
          this.onabort?.();
        }
        send() {
          sent = true;
          if (mode === "send-throws") throw new Error("send failed");
          if (mode === "during-send") {
            controller.abort();
            return;
          }
          this.upload.onprogress?.({
            loaded: 3,
            total: 3,
            lengthComputable: true,
          });
          this.status = 200;
          this.onload?.();
        }
      };
      globalThis.fetch = async (_url, options) => {
        if (options.method === "POST")
          return Response.json(uploadAuthorization());
        if (options.method === "DELETE") {
          cleaned = true;
          return Response.json({ success: true });
        }
        return Response.json({ file: storedFileFixture() });
      };
      const upload = owner.files.upload(new Blob(["abc"]), {
        signal: controller.signal,
        onProgress: () => {
          if (mode === "progress-throws") throw new Error("callback failed");
        },
      });
      if (mode === "success") assert.equal((await upload).id, "file_one");
      else
        await assert.rejects(
          upload,
          mode.includes("send") && mode !== "send-throws"
            ? { code: "REQUEST_ABORTED" }
            : NaruDataError,
        );
      assert.equal(sent, mode !== "before-send");
      assert.equal(cleaned, mode !== "success");
      assert.equal(xhr.onload, null);
      assert.equal(xhr.upload.onprogress, null);
    }
  } finally {
    globalThis.fetch = oldFetch;
    globalThis.window = oldWindow;
    globalThis.XMLHttpRequest = oldXHR;
  }
});

test("authentication accepts cancellation without navigating or consuming a callback when already aborted", async () => {
  const oldFetch = globalThis.fetch,
    oldWindow = globalThis.window;
  try {
    const browser = fakeBrowser();
    globalThis.window = browser;
    const controller = new AbortController();
    controller.abort();
    const db = createDatabase({ site: "alice" });
    const before = browser.location.href;
    globalThis.fetch = () => {
      assert.fail("must not send");
    };
    await assert.rejects(
      db.signInAsOwner({
        clientId: "registered",
        collections: ["posts"],
        signal: controller.signal,
      }),
      { code: "REQUEST_ABORTED" },
    );
    await assert.rejects(
      db.completeOwnerSignIn({ signal: controller.signal }),
      { code: "REQUEST_ABORTED" },
    );
    assert.equal(browser.location.href, before);
    const owner = await restoreTestOwner();
    await assert.rejects(owner.signOut({ signal: controller.signal }), {
      code: "REQUEST_ABORTED",
    });
    await assert.rejects(owner.collection("posts").list(), {
      code: "OWNER_SESSION_EXPIRED",
    });
  } finally {
    globalThis.fetch = oldFetch;
    globalThis.window = oldWindow;
  }
});

test("collection registries validate own properties eagerly without invoking getters", () => {
  for (const collections of [
    null,
    [],
    { posts: undefined },
    { posts: true },
    { posts: { parse: true } },
    { posts: { map: "yes" } },
    // serialize was folded into writing the application's own JSON.
    { posts: { serialize: () => ({}) } },
    { "bad/name": {} },
    { [Symbol("posts")]: {} },
  ])
    assert.throws(
      () => createDatabase({ site: "alice", collections }),
      TypeError,
    );
  let invoked = false;
  for (const collections of [
    {
      get posts() {
        invoked = true;
        return {};
      },
    },
    {
      posts: {
        get parse() {
          invoked = true;
          return () => ({});
        },
      },
    },
  ])
    assert.throws(
      () => createDatabase({ site: "alice", collections }),
      TypeError,
    );
  assert.equal(invoked, false);
  const hidden = Object.defineProperty({}, "posts", { value: false });
  assert.throws(
    () => createDatabase({ site: "alice", collections: hidden }),
    TypeError,
  );
  // The removed options say where their replacement lives instead of being
  // silently ignored, which would let unvalidated writes through.
  assert.throws(
    () => createDatabase({ site: "alice", schemas: { posts: () => true } }),
    /collections/,
  );
  assert.throws(
    () =>
      createDatabase({ site: "alice" }).collection("posts", { parse: titled }),
    /createDatabase/,
  );
});

test("registries ignore inherited names and retain a snapshot of own definitions", async () => {
  const oldFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => Response.json(writtenFixture());
    const refuse = () => {
      throw new TypeError("refused");
    };
    const collections = Object.create({
      posts: {
        parse: () => {
          throw new Error("inherited parser ran");
        },
      },
    });
    collections.notes = { parse: refuse };
    const db = createDatabase({ site: "alice", collections });
    collections.notes = { parse: () => ({}) };
    collections.notes.parse = () => ({});
    await db.collection("posts").add({});
    await db.collection("constructor").add({});
    await db.collection("toString").add({});
    assert.throws(() => db.collection("notes").add({}), TypeError);
    const own = Object.create(null);
    own.constructor = { parse: refuse };
    assert.throws(
      () =>
        createDatabase({ site: "alice", collections: own })
          .collection("constructor")
          .add({}),
      TypeError,
    );
  } finally {
    globalThis.fetch = oldFetch;
  }
});

test("full writes reject asynchronous and throwing parsers before sending", async () => {
  const oldFetch = globalThis.fetch,
    oldWindow = globalThis.window;
  try {
    await restoreTestOwner();
    let requests = 0;
    globalThis.fetch = async () => {
      requests++;
      return Response.json(writtenFixture());
    };
    for (const parse of [
      async () => ({}),
      async () => {
        throw new Error("async validation failed");
      },
      () => Promise.resolve({}),
      () => ({
        then(resolve) {
          resolve({});
        },
      }),
      (data) => {
        data.lost = undefined;
        return data;
      },
      () => {
        throw new TypeError("refused");
      },
    ]) {
      const db = createDatabase({
        site: "alice",
        collections: { posts: { parse } },
      });
      const posts = db.collection("posts");
      assert.throws(() => posts.add({}), TypeError);
      assert.throws(() => posts.set("one", {}), TypeError);
      const owner = await db.completeOwnerSignIn();
      for (const type of ["add", "set"])
        assert.throws(
          () =>
            owner.batch([
              {
                type,
                collection: "posts",
                ...(type === "set" ? { id: "one" } : {}),
                data: {},
              },
            ]),
          TypeError,
        );
    }
    // Give rejected async parsers time to report any unhandled rejection.
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(requests, 0);
    // A parser's return value is the read shape; any synchronous value passes.
    for (const parse of [() => ({}), () => undefined, () => false])
      await createDatabase({ site: "alice", collections: { posts: { parse } } })
        .collection("posts")
        .add({});
    const failure = new Error("parser detail");
    assert.throws(
      () =>
        createDatabase({
          site: "alice",
          collections: {
            posts: {
              parse: () => {
                throw failure;
              },
            },
          },
        })
          .collection("posts")
          .add({}),
      (error) => error === failure,
    );
  } finally {
    globalThis.fetch = oldFetch;
    globalThis.window = oldWindow;
  }
});

test("registered read parsers shape data without changing server metadata", async () => {
  const oldFetch = globalThis.fetch,
    oldWindow = globalThis.window;
  try {
    await restoreTestOwner();
    const stored = documentFixture("one", { title: "hello", legacy: true });
    globalThis.fetch = async () =>
      Response.json({
        document: stored,
        documents: [stored],
        nextPageToken: null,
      });
    let calls = 0;
    const db = createDatabase({
      site: "alice",
      collections: {
        posts: {
          parse: (data) => {
            calls++;
            return { title: data.title.toUpperCase() };
          },
        },
      },
    });
    // The owner client shares the registry of the database it signed in from.
    const owner = await db.completeOwnerSignIn();
    for (const client of [db, owner]) {
      calls = 0;
      const posts = client.collection("posts");
      assert.deepEqual(await posts.get("one"), {
        ...stored,
        data: { title: "HELLO" },
      });
      assert.deepEqual((await posts.list()).documents[0].data, {
        title: "HELLO",
      });
      const values = [];
      for await (const document of posts.all()) values.push(document.data);
      assert.deepEqual(values, [{ title: "HELLO" }]);
      assert.equal(calls, 3);
      // Unregistered collections come back exactly as stored.
      assert.deepEqual(
        (await client.collection("notes").get("one")).data,
        stored.data,
      );
    }
    for (const value of [false, null, undefined])
      assert.equal(
        (
          await createDatabase({
            site: "alice",
            collections: { posts: { parse: () => value } },
          })
            .collection("posts")
            .get("one")
        ).data,
        value,
      );
  } finally {
    globalThis.fetch = oldFetch;
    globalThis.window = oldWindow;
  }
});

test("collection definitions parse and map every handle and guard batches", async () => {
  const oldFetch = globalThis.fetch,
    oldWindow = globalThis.window;
  try {
    await restoreTestOwner();
    const calls = [];
    const stored = documentFixture("one", { title: "hello" });
    globalThis.fetch = async (url, init = {}) => {
      calls.push({ url: new URL(url), init });
      if (new URL(url).pathname.endsWith("/_batch"))
        return Response.json({ results: [writtenFixture()] });
      if (init.method === "POST" || init.method === "PUT")
        return Response.json(writtenFixture());
      return Response.json({
        document: stored,
        documents: [stored],
        nextPageToken: null,
      });
    };
    const db = createDatabase({
      site: "alice",
      collections: {
        posts: {
          parse(data) {
            if (typeof data?.title !== "string") throw new Error("bad post");
            return { title: data.title.toUpperCase() };
          },
          map(document) {
            return {
              id: document.id,
              heading: document.data.title,
              version: document.version,
            };
          },
        },
      },
    });
    assert.deepEqual(await db.collection("posts").get("one"), {
      id: "one",
      heading: "HELLO",
      version: 1,
    });
    assert.deepEqual((await db.collection("posts").list()).documents, [
      { id: "one", heading: "HELLO", version: 1 },
    ]);
    // Writes store the JSON given, not the parser's normalized read shape.
    await db.collection("posts").set("one", { title: "saved" });
    assert.deepEqual(JSON.parse(calls.at(-1).init.body), {
      data: { title: "saved" },
    });
    const owner = await db.completeOwnerSignIn();
    await owner.batch([
      { type: "set", collection: "posts", id: "two", data: { title: "b" } },
    ]);
    assert.deepEqual(JSON.parse(calls.at(-1).init.body).operations[0].data, {
      title: "b",
    });
    const before = calls.length;
    assert.throws(
      () =>
        owner.batch([
          { type: "set", collection: "posts", id: "two", data: { heading: 1 } },
        ]),
      /bad post/,
    );
    assert.equal(calls.length, before);
  } finally {
    globalThis.fetch = oldFetch;
    globalThis.window = oldWindow;
  }
});

test("read parser failures identify the document and reject the entire failing page", async () => {
  const oldFetch = globalThis.fetch;
  try {
    const failure = new Error("title must be a string");
    const posts = createDatabase({
      site: "alice",
      collections: {
        posts: {
          parse: (data) => {
            if (typeof data.title !== "string") throw failure;
            return data;
          },
        },
      },
    }).collection("posts");
    const good = documentFixture("good", { title: "hello" }),
      bad = documentFixture("bad", { title: 42 });
    const check = (error) => {
      assert.ok(error instanceof NaruDataError);
      assert.equal(error.code, "DOCUMENT_VALIDATION_FAILED");
      assert.equal(error.collection, "posts");
      assert.equal(error.documentId, "bad");
      assert.equal(error.cause, failure);
      return true;
    };
    globalThis.fetch = async () =>
      Response.json({
        document: bad,
        documents: [good, bad],
        nextPageToken: null,
      });
    await assert.rejects(posts.get("bad"), check);
    await assert.rejects(posts.list(), check);
    await assert.rejects(posts.all().next(), check);
    let calls = 0;
    globalThis.fetch = async () =>
      Response.json(
        ++calls === 1
          ? { documents: [good], nextPageToken: "next" }
          : { documents: [good, bad], nextPageToken: "more" },
      );
    const iterator = posts.all();
    assert.equal((await iterator.next()).value.id, "good");
    await assert.rejects(iterator.next(), check);
    assert.equal(calls, 2);
    assert.equal((await iterator.next()).done, true);
  } finally {
    globalThis.fetch = oldFetch;
  }
});

test("read parsers reject async results without masking transport errors", async () => {
  const oldFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () =>
      Response.json({ document: documentFixture("one", {}) });
    const reader = (parse) =>
      createDatabase({
        site: "alice",
        collections: { posts: { parse } },
      }).collection("posts");
    for (const parse of [
      async () => ({}),
      async () => {
        throw new Error("async failure");
      },
      () => ({
        then(resolve) {
          resolve({});
        },
      }),
    ])
      await assert.rejects(
        reader(parse).get("one"),
        (error) =>
          error.code === "DOCUMENT_VALIDATION_FAILED" &&
          error.documentId === "one" &&
          error.cause instanceof TypeError,
      );
    await new Promise((resolve) => setImmediate(resolve));
    let invoked = false;
    const posts = reader(() => {
      invoked = true;
    });
    for (const [response, code] of [
      [
        () => Response.json({ error: "missing" }, { status: 404 }),
        "REQUEST_FAILED",
      ],
      [() => Response.json({ document: {} }), "INVALID_RESPONSE"],
    ]) {
      globalThis.fetch = async () => response();
      await assert.rejects(posts.get("one"), { code });
    }
    assert.equal(invoked, false);
  } finally {
    globalThis.fetch = oldFetch;
  }
});

test("parsers run for reads and full writes, never for counts, patches or deletes", async () => {
  const oldFetch = globalThis.fetch;
  try {
    const seen = [];
    const posts = createDatabase({
      site: "alice",
      collections: {
        posts: {
          parse: (data) => {
            seen.push(data);
            return data;
          },
        },
      },
    }).collection("posts");
    globalThis.fetch = async (_url, options) =>
      Response.json(
        options.method === "DELETE"
          ? { success: true }
          : {
              ...writtenFixture(),
              count: 2,
              document: documentFixture("one", { read: true }),
            },
      );
    assert.equal(await posts.count(), 2);
    await posts.update("one", { patch: true });
    await posts.delete("one");
    assert.deepEqual(seen, []);
    await posts.add({ added: true });
    await posts.set("one", { set: true });
    await posts.get("one");
    assert.deepEqual(seen, [{ added: true }, { set: true }, { read: true }]);
  } finally {
    globalThis.fetch = oldFetch;
  }
});

// Stands in for the browser's decode/encode pair so the resize path can be
// exercised where neither createImageBitmap nor OffscreenCanvas exists.
function fakeImagePipeline({ width, height, encoded }) {
  const oldBitmap = globalThis.createImageBitmap,
    oldCanvas = globalThis.OffscreenCanvas;
  const drawn = [];
  globalThis.createImageBitmap = async (_blob, options) => ({
    width,
    height,
    options,
    close() {
      this.closed = true;
    },
  });
  globalThis.OffscreenCanvas = class {
    constructor(canvasWidth, canvasHeight) {
      this.width = canvasWidth;
      this.height = canvasHeight;
    }
    getContext() {
      return {
        drawImage: (_bitmap, _x, _y, targetWidth, targetHeight) =>
          drawn.push([targetWidth, targetHeight]),
      };
    }
    async convertToBlob({ type, quality }) {
      drawn.push({ type, quality });
      return encoded({
        type,
        quality,
        width: this.width,
        height: this.height,
      });
    }
  };
  return {
    drawn,
    restore() {
      globalThis.createImageBitmap = oldBitmap;
      globalThis.OffscreenCanvas = oldCanvas;
    },
  };
}

function captureUpload() {
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), options });
    if (String(url) === "https://upload.example/signed")
      return new Response(null, { status: 200 });
    if (options.method === "POST") return Response.json(uploadAuthorization());
    return Response.json({ file: storedFileFixture() });
  };
  return calls;
}

test("oversized photos are downscaled before authorization so the declared size stays honest", async () => {
  const oldWindow = globalThis.window,
    oldFetch = globalThis.fetch;
  const image = fakeImagePipeline({
    width: 8000,
    height: 6000,
    encoded: ({ type }) => new Blob(["x".repeat(1024)], { type }),
  });
  const calls = captureUpload();
  try {
    const owner = await restoreTestOwner();
    const original = new File(
      [new Uint8Array(30 * 1024 * 1024)],
      "IMG_0001.HEIC",
      { type: "image/heic" },
    );
    // Over the 25 MiB ceiling as taken; the shrunk copy is what gets measured.
    await owner.files.upload(original);
    assert.deepEqual(JSON.parse(calls[0].options.body), {
      name: "IMG_0001.webp",
      contentType: "image/webp",
      size: 1024,
      metadata: {},
    });
    assert.equal(calls[1].options.body.size, 1024);
    assert.equal(calls[1].options.body.type, "image/webp");
    // 8000x6000 fits the 2048 box on its long edge, and EXIF rotation is baked
    // into the pixels because the canvas would otherwise drop it.
    assert.deepEqual(image.drawn[0], [2048, 1536]);
    assert.deepEqual(image.drawn[1], { type: "image/webp", quality: 0.82 });
  } finally {
    image.restore();
    globalThis.window = oldWindow;
    globalThis.fetch = oldFetch;
  }
});

test("resizing keeps the original when it is already small, would grow, or is declined", async () => {
  const oldWindow = globalThis.window,
    oldFetch = globalThis.fetch;
  const cases = [
    // Within the pixel box and under maxBytes: a hand-tuned PNG stays exact.
    { width: 800, height: 600, size: 4096, options: {} },
    // Re-encoding an efficient image can cost bytes; the smaller one wins.
    { width: 8000, height: 6000, size: 4096, options: {} },
    // An encoder that ignored the requested type is not trusted.
    // The caller asked for the bytes it handed over.
    { width: 8000, height: 6000, size: 4096, options: { original: true } },
  ];
  try {
    for (const { width, height, size, options, encodedType } of cases) {
      const image = fakeImagePipeline({
        width,
        height,
        encoded: ({ type }) =>
          new Blob(["x".repeat(size)], { type: encodedType || type }),
      });
      const calls = captureUpload();
      try {
        const owner = await restoreTestOwner();
        await owner.files.upload(
          new File([new Uint8Array(2048)], "photo.png", { type: "image/png" }),
          options,
        );
        assert.deepEqual(JSON.parse(calls[0].options.body), {
          name: "photo.png",
          contentType: "image/png",
          size: 2048,
          metadata: {},
        });
      } finally {
        image.restore();
      }
    }
  } finally {
    globalThis.window = oldWindow;
    globalThis.fetch = oldFetch;
  }
});

test("image options are validated and a shrunk file still faces the upload limits", async () => {
  const oldWindow = globalThis.window,
    oldFetch = globalThis.fetch;
  const image = fakeImagePipeline({
    width: 8000,
    height: 6000,
    encoded: ({ type }) =>
      new Blob([new Uint8Array(26 * 1024 * 1024)], { type }),
  });
  captureUpload();
  try {
    const owner = await restoreTestOwner();
    const photo = new File([new Uint8Array(30 * 1024 * 1024)], "photo.jpg", {
      type: "image/jpeg",
    });
    for (const bad of [
      { maxDimension: 0 },
      { maxDimension: 2048.5 },
      { maxDimension: 16385 },
      { quality: 0 },
      { quality: 1.1 },
      { type: "image/gif" },
      { type: "image/svg+xml" },
      { maxBytes: 0 },
      { maxBytes: -1 },
      { maxBytes: 1.5 },
    ])
      await assert.rejects(
        owner.files.upload(photo, { image: bad }),
        TypeError,
      );
    for (const bad of [null, false, "yes", []])
      await assert.rejects(
        owner.files.upload(photo, { image: bad }),
        TypeError,
      );
    for (const bad of ["yes", 1, null])
      await assert.rejects(
        owner.files.upload(photo, { original: bad }),
        TypeError,
      );
    // Still too heavy after shrinking, so the limit applies to the resized copy.
    await assert.rejects(owner.files.upload(photo), {
      name: "TypeError",
      message: "File must be between 1 byte and 25 MiB.",
    });
  } finally {
    image.restore();
    globalThis.window = oldWindow;
    globalThis.fetch = oldFetch;
  }
});

test("encoding spends quality then pixels until the byte budget is met", async () => {
  const oldWindow = globalThis.window,
    oldFetch = globalThis.fetch;
  const budget = 500 * 1024;
  const cases = [
    {
      label: "quality alone reaches the budget",
      // A lossy encoder: bytes track pixels and quality together.
      encoded: ({ width, height, quality }) =>
        Math.round(width * height * quality * 0.35),
      qualities: [0.82, 0.7, 0.58, 0.46],
      // Every attempt redraws, so the box repeats until quality suffices.
      sizes: [
        [2048, 1365],
        [2048, 1365],
        [2048, 1365],
        [2048, 1365],
      ],
    },
    {
      label: "lossless output can only shed pixels",
      type: "image/png",
      encoded: ({ width, height }) => Math.round(width * height * 0.3),
      // Quality never moves for a lossless type; only the box shrinks, and a
      // near miss still takes a real step rather than stalling over budget.
      qualities: [0.82, 0.82, 0.82],
      sizes: [
        [2048, 1365],
        [1600, 1067],
        [1520, 1014],
      ],
    },
  ];
  try {
    for (const { label, type, encoded, qualities, sizes } of cases) {
      const image = fakeImagePipeline({
        width: 6000,
        height: 4000,
        encoded: (options) =>
          new Blob(["x".repeat(encoded(options))], { type: options.type }),
      });
      const calls = captureUpload();
      try {
        const owner = await restoreTestOwner();
        await owner.files.upload(
          new File([new Uint8Array(12 * 1024 * 1024)], "photo.jpg", {
            type: "image/jpeg",
          }),
          type ? { image: { type } } : {},
        );
        const declared = JSON.parse(calls[0].options.body);
        assert.ok(
          declared.size <= budget,
          `${label}: ${declared.size} exceeds the budget`,
        );
        // Each attempt draws at its size, then encodes at its quality.
        assert.deepEqual(
          image.drawn.filter(Array.isArray),
          sizes,
          `${label}: drawn sizes`,
        );
        assert.deepEqual(
          image.drawn
            .filter((entry) => !Array.isArray(entry))
            .map((e) => e.quality),
          qualities,
          `${label}: qualities tried`,
        );
      } finally {
        image.restore();
      }
    }
  } finally {
    globalThis.window = oldWindow;
    globalThis.fetch = oldFetch;
  }
});

test("an unreachable budget still uploads the smallest attempt", async () => {
  const oldWindow = globalThis.window,
    oldFetch = globalThis.fetch;
  // Nothing this encoder produces fits, so the search exhausts its attempts.
  const image = fakeImagePipeline({
    width: 6000,
    height: 4000,
    encoded: ({ type }) => new Blob(["x".repeat(700 * 1024)], { type }),
  });
  const calls = captureUpload();
  try {
    const owner = await restoreTestOwner();
    await owner.files.upload(
      new File([new Uint8Array(12 * 1024 * 1024)], "photo.jpg", {
        type: "image/jpeg",
      }),
    );
    const declared = JSON.parse(calls[0].options.body);
    assert.equal(declared.size, 700 * 1024);
    assert.equal(declared.contentType, "image/webp");
    // Six attempts, and the giving up is bounded rather than a spin.
    assert.equal(image.drawn.filter(Array.isArray).length, 6);
  } finally {
    image.restore();
    globalThis.window = oldWindow;
    globalThis.fetch = oldFetch;
  }
});

test("a browser that cannot encode WebP falls back to JPEG instead of the original", async () => {
  const oldWindow = globalThis.window,
    oldFetch = globalThis.fetch;
  // Safari has historically substituted PNG for a canvas type it cannot
  // encode. Bailing there shipped the untouched original.
  const image = fakeImagePipeline({
    width: 6000,
    height: 4000,
    encoded: ({ type }) =>
      new Blob(["x".repeat(4096)], {
        type: type === "image/webp" ? "image/png" : type,
      }),
  });
  const calls = captureUpload();
  try {
    const owner = await restoreTestOwner();
    await owner.files.upload(
      new File([new Uint8Array(13 * 1024 * 1024)], "DSCF0411.JPG", {
        type: "image/jpeg",
      }),
    );
    assert.deepEqual(JSON.parse(calls[0].options.body), {
      name: "DSCF0411.jpg",
      contentType: "image/jpeg",
      size: 4096,
      metadata: {},
    });
    // WebP is tried first, then abandoned for JPEG rather than given up on.
    assert.deepEqual(
      image.drawn.filter((entry) => !Array.isArray(entry)).map((e) => e.type),
      ["image/webp", "image/jpeg"],
    );
  } finally {
    image.restore();
    globalThis.window = oldWindow;
    globalThis.fetch = oldFetch;
  }
});

test("an encoder that substitutes an unusable type for every request keeps the original", async () => {
  const oldWindow = globalThis.window,
    oldFetch = globalThis.fetch;
  const image = fakeImagePipeline({
    width: 6000,
    height: 4000,
    encoded: () => new Blob(["x".repeat(4096)], { type: "image/gif" }),
  });
  const calls = captureUpload();
  try {
    const owner = await restoreTestOwner();
    await owner.files.upload(
      new File([new Uint8Array(2048)], "photo.jpg", { type: "image/jpeg" }),
    );
    assert.deepEqual(JSON.parse(calls[0].options.body), {
      name: "photo.jpg",
      contentType: "image/jpeg",
      size: 2048,
      metadata: {},
    });
  } finally {
    image.restore();
    globalThis.window = oldWindow;
    globalThis.fetch = oldFetch;
  }
});

test("the media library pages and filters like a collection instead of loading whole", async () => {
  const oldWindow = globalThis.window,
    oldFetch = globalThis.fetch;
  const urls = [];
  try {
    const owner = await restoreTestOwner();
    const pages = [
      { files: [storedFileFixture()], nextPageToken: "v1.second" },
      {
        files: [{ ...storedFileFixture(), id: "file_two" }],
        nextPageToken: null,
      },
    ];
    globalThis.fetch = async (url) => {
      urls.push(new URL(url));
      return Response.json(pages[urls.length - 1]);
    };
    const page = await owner.files.list({
      where: { postId: "hello" },
      limit: 2,
      orderBy: "updatedAt",
      direction: "asc",
    });
    assert.deepEqual(
      page.files.map((file) => file.id),
      ["file_one"],
    );
    assert.equal(page.nextPageToken, "v1.second");
    assert.equal(urls[0].pathname, "/api/data/alice/_files");
    assert.deepEqual(JSON.parse(urls[0].searchParams.get("where")), {
      postId: "hello",
    });
    assert.equal(urls[0].searchParams.get("limit"), "2");
    assert.equal(urls[0].searchParams.get("orderBy"), "updatedAt");
    assert.equal(urls[0].searchParams.get("direction"), "asc");
    assert.equal(urls[0].searchParams.has("pageToken"), false);
    urls.length = 0;
    pages.length = 0;
    pages.push(
      { files: [storedFileFixture()], nextPageToken: "v1.second" },
      {
        files: [{ ...storedFileFixture(), id: "file_two" }],
        nextPageToken: null,
      },
    );
    const walked = [];
    for await (const file of owner.files.all({ where: { postId: "hello" } }))
      walked.push(file.id);
    assert.deepEqual(walked, ["file_one", "file_two"]);
    assert.equal(urls[1].searchParams.get("pageToken"), "v1.second");
    assert.equal(urls[1].searchParams.get("limit"), "100");
    // A document field is not something a file has to sort by.
    assert.throws(() => owner.files.list({ orderBy: "data.title" }), TypeError);
  } finally {
    globalThis.window = oldWindow;
    globalThis.fetch = oldFetch;
  }
});

test("a quota readout is its own request and never pages the library", async () => {
  const oldWindow = globalThis.window,
    oldFetch = globalThis.fetch;
  const urls = [];
  try {
    const owner = await restoreTestOwner();
    const usage = { bytes: 10, count: 1, pending: 0, maxBytes: 1000 };
    globalThis.fetch = async (url) => {
      urls.push(new URL(url));
      return Response.json({ usage });
    };
    assert.deepEqual(await owner.files.usage(), usage);
    assert.equal(urls[0].searchParams.get("usage"), "1");
    assert.equal(urls[0].searchParams.has("limit"), false);
    // Without the flag the same envelope is not a listing and is refused.
    globalThis.fetch = async () => Response.json({ usage });
    await assert.rejects(owner.files.list(), { code: "INVALID_RESPONSE" });
  } finally {
    globalThis.window = oldWindow;
    globalThis.fetch = oldFetch;
  }
});

test("file metadata is patchable under a version check", async () => {
  const oldWindow = globalThis.window,
    oldFetch = globalThis.fetch;
  const calls = [];
  try {
    const owner = await restoreTestOwner();
    globalThis.fetch = async (url, options) => {
      calls.push({ url: new URL(url), options });
      return Response.json({
        file: {
          ...storedFileFixture(),
          metadata: { postId: "moved" },
          version: 2,
        },
      });
    };
    const file = await owner.files.update(
      "file_one",
      { postId: "moved" },
      { ifVersion: 1, unset: ["draft"] },
    );
    assert.deepEqual(file.metadata, { postId: "moved" });
    assert.equal(file.version, 2);
    assert.equal(calls[0].options.method, "PATCH");
    assert.equal(calls[0].url.pathname, "/api/data/alice/_files/file_one");
    assert.equal(calls[0].url.searchParams.get("ifVersion"), "1");
    assert.deepEqual(JSON.parse(calls[0].options.body), {
      data: { postId: "moved" },
      unset: ["draft"],
    });
    await assert.rejects(owner.files.update("file_one", null), TypeError);
  } finally {
    globalThis.window = oldWindow;
    globalThis.fetch = oldFetch;
  }
});

test("the anonymous client carries no surface that only an owner token can use", async () => {
  const db = createDatabase({ site: "alice" });
  assert.equal(db.files, undefined);
  assert.equal(db.batch, undefined);
  assert.equal(typeof db.collection, "function");
  const oldWindow = globalThis.window;
  try {
    const owner = await restoreTestOwner();
    assert.equal(typeof owner.files.upload, "function");
    assert.equal(typeof owner.batch, "function");
  } finally {
    globalThis.window = oldWindow;
  }
});

test("counting refuses a sort order it has no page to apply", async () => {
  const original = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async () => {
    requests += 1;
    return Response.json({ count: 0 });
  };
  try {
    const posts = createDatabase({ site: "alice" }).collection("posts");
    await assert.rejects(posts.count({ orderBy: "createdAt" }), TypeError);
    await assert.rejects(posts.count({ direction: "desc" }), TypeError);
    assert.equal(await posts.count({ where: { published: true } }), 0);
    assert.equal(requests, 1);
  } finally {
    globalThis.fetch = original;
  }
});

test("resizing announces itself before any bytes move", async () => {
  const oldWindow = globalThis.window,
    oldFetch = globalThis.fetch;
  const image = fakeImagePipeline({
    width: 8000,
    height: 6000,
    encoded: ({ type }) => new Blob(["x".repeat(1024)], { type }),
  });
  const calls = captureUpload();
  const events = [];
  try {
    const owner = await restoreTestOwner();
    await owner.files.upload(
      new File([new Uint8Array(4 * 1024 * 1024)], "IMG.HEIC", {
        type: "image/heic",
      }),
      { onProgress: (event) => events.push(event) },
    );
    // The resize is reported before the authorization request is even sent,
    // so a caller never has to guess which files the SDK will re-encode.
    assert.deepEqual(events[0], {
      loaded: 0,
      total: 4 * 1024 * 1024,
      phase: "resizing",
    });
    assert.equal(calls[0].url, "https://naru.pub/api/data/alice/_files");
    // A small file that is left alone gets no resizing event at all.
    events.length = 0;
    calls.length = 0;
    await owner.files.upload(new Blob(["abc"], { type: "text/plain" }), {
      onProgress: (event) => events.push(event),
    });
    assert.deepEqual(events, []);
  } finally {
    image.restore();
    globalThis.window = oldWindow;
    globalThis.fetch = oldFetch;
  }
});

test("a throwing progress callback fails the upload rather than shipping the original", async () => {
  const oldWindow = globalThis.window,
    oldFetch = globalThis.fetch;
  const image = fakeImagePipeline({
    width: 8000,
    height: 6000,
    encoded: ({ type }) => new Blob(["x".repeat(1024)], { type }),
  });
  const calls = captureUpload();
  try {
    const owner = await restoreTestOwner();
    await assert.rejects(
      owner.files.upload(
        new File([new Uint8Array(4 * 1024 * 1024)], "IMG.HEIC", {
          type: "image/heic",
        }),
        {
          onProgress: () => {
            throw new Error("reporting failed");
          },
        },
      ),
      { message: "reporting failed" },
    );
    assert.deepEqual(calls, []);
  } finally {
    image.restore();
    globalThis.window = oldWindow;
    globalThis.fetch = oldFetch;
  }
});

test("an upload redirected off its authorized origin fails and is cleaned up", async () => {
  const oldWindow = globalThis.window,
    oldFetch = globalThis.fetch;
  const calls = [];
  try {
    const owner = await restoreTestOwner();
    globalThis.fetch = async (url, options) => {
      calls.push({ url: String(url), options });
      if (String(url) === "https://upload.example/signed")
        return Object.defineProperty(
          new Response(null, { status: 200 }),
          "url",
          {
            value: "https://elsewhere.example/signed",
          },
        );
      if (options.method === "POST")
        return Response.json(uploadAuthorization());
      return Response.json({ success: true });
    };
    await assert.rejects(
      owner.files.upload(new Blob(["abc"], { type: "text/plain" })),
      (error) =>
        error.code === "UPLOAD_REDIRECTED" && error.fileId === "file_one",
    );
    // The authorization is not left dangling against the storage quota.
    assert.equal(calls.at(-1).options.method, "DELETE");
  } finally {
    globalThis.window = oldWindow;
    globalThis.fetch = oldFetch;
  }
});

test("a callback completes on a page that carries its own query string", async () => {
  const oldWindow = globalThis.window,
    oldFetch = globalThis.fetch;
  const browser = fakeBrowser();
  globalThis.window = browser;
  globalThis.fetch = async () =>
    Response.json({
      accessToken: "t".repeat(43),
      expiresIn: 86400,
      expiresAt: Date.now() + 24 * 3600000,
      tokenType: "Bearer",
    });
  try {
    const db = createDatabase({ site: "alice" });
    await db.signInAsOwner({ clientId: "registered", collections: ["posts"] });
    const saved = JSON.parse([...browser.storage.values()][0]);
    // A static site routes on the query string, and providers may append their
    // own parameters. Neither is the callback being a different callback.
    browser.location.href = `${saved.redirectUri}?post=hello&code=${"c".repeat(43)}&state=${saved.state}&iss=https%3A%2F%2Fnaru.pub`;
    assert.notEqual(await db.completeOwnerSignIn(), null);
    assert.equal(
      browser.location.href,
      "https://alice.example/admin.html?post=hello&iss=https%3A%2F%2Fnaru.pub",
    );
  } finally {
    globalThis.window = oldWindow;
    globalThis.fetch = oldFetch;
  }
});

test("an empty filter and a null page token both mean no constraint", async () => {
  const original = globalThis.fetch;
  const urls = [];
  globalThis.fetch = async (url) => {
    urls.push(new URL(url));
    return Response.json({ documents: [], nextPageToken: null, count: 0 });
  };
  try {
    const posts = createDatabase({ site: "alice" }).collection("posts");
    await posts.list({ where: {}, pageToken: null });
    await posts.count({ where: {} });
    for (const url of urls) {
      assert.equal(url.searchParams.has("where"), false);
      assert.equal(url.searchParams.has("pageToken"), false);
    }
    // Feeding a finished page's token straight back reads the first page.
    const page = await posts.list();
    await posts.list({ pageToken: page.nextPageToken });
    assert.equal(urls.at(-1).searchParams.has("pageToken"), false);
    for (const pageToken of ["", 0, false])
      assert.throws(() => posts.list({ pageToken }), TypeError);
  } finally {
    globalThis.fetch = original;
  }
});

test("any write, signed in or not, makes this browser's reads of that collection fresh", async () => {
  const oldFetch = globalThis.fetch,
    oldNow = Date.now;
  let now = oldNow();
  Date.now = () => now;
  try {
    const calls = [];
    globalThis.fetch = async (url, options) => {
      calls.push({ url: new URL(url), options });
      return options.method === "GET"
        ? Response.json({ documents: [], nextPageToken: null })
        : Response.json(writtenFixture());
    };
    const db = createDatabase({ site: "alice" });
    const guestbook = db.collection("guestbook");
    await guestbook.add({ message: "hi" });
    await guestbook.list();
    await db.collection("posts").list();
    assert.equal(calls[1].options.cache, "no-store");
    assert.equal(calls[2].options.cache, "default");
    now += 10_001;
    await guestbook.list();
    assert.equal(calls[3].options.cache, "default");
    // A write that never got an answer may still have landed.
    globalThis.fetch = async () => {
      throw new TypeError("offline");
    };
    await assert.rejects(guestbook.add({ message: "again" }), {
      code: "REQUEST_FAILED",
    });
    globalThis.fetch = async (url, options) => {
      calls.push({ url: new URL(url), options });
      return Response.json({ documents: [], nextPageToken: null });
    };
    await guestbook.list();
    assert.equal(calls.at(-1).options.cache, "no-store");
  } finally {
    globalThis.fetch = oldFetch;
    Date.now = oldNow;
  }
});
