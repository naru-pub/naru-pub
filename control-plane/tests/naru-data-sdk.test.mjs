import { test } from "node:test";
import assert from "node:assert/strict";
import { createDatabase, NaruDataError } from "../public/sdk/naru-data.js";

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
