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
        expiresIn: 600,
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
    assert.equal(browser.storage.size, 0);
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
    assert.throws(
      () => admin.collection("posts").list(),
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
