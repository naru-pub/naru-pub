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
    await assert.rejects(restored.signOut(), /Offline/);
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
