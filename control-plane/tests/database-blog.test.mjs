// Run: node --experimental-vm-modules --test tests/database-blog.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { SourceTextModule, SyntheticModule } from "node:vm";
const require = createRequire(import.meta.url);
const { JSDOM } = createRequire(require.resolve("jest-environment-jsdom"))(
  "jsdom",
);
const root = new URL("../public/examples/database-blog/", import.meta.url);
async function page(name, db, storage = new Map(), query = "") {
  const dom = new JSDOM(await readFile(new URL(`${name}.html`, root), "utf8"), {
    url: `https://example.naru.pub/blog/${name}.html${query}`,
    runScripts: "outside-only",
  });
  const { window } = dom;
  for (const [key, value] of storage) window.sessionStorage.setItem(key, value);
  const context = dom.getInternalVMContext(),
    events = new Map();
  const add = window.EventTarget.prototype.addEventListener;
  window.EventTarget.prototype.addEventListener = function (
    type,
    handler,
    ...rest
  ) {
    if (this.id) events.set(`${this.id}:${type}`, handler);
    return add.call(this, type, handler, ...rest);
  };
  const modules = new Map();
  modules.set(
    "config.js",
    new SyntheticModule(
      ["config"],
      function () {
        this.setExport("config", {
          site: "example",
          clientId: "example-client",
        });
      },
      { context },
    ),
  );
  modules.set(
    "client.js",
    new SyntheticModule(
      ["connect"],
      function () {
        this.setExport("connect", async () => db);
      },
      { context },
    ),
  );
  async function load(name) {
    if (modules.has(name)) return modules.get(name);
    const mod = new SourceTextModule(
      await readFile(new URL(name, root), "utf8"),
      { context },
    );
    modules.set(name, mod);
    await mod.link((specifier) => load(specifier.replace(/^\.\//, "")));
    return mod;
  }
  const script = window.document
    .querySelector('script[type="module"]')
    .getAttribute("src")
    .slice(2);
  await (await load(script)).evaluate();
  return {
    $: (id) => window.document.getElementById(id),
    fire: (id, type) => events.get(`${id}:${type}`)({ preventDefault() {} }),
    storage: () =>
      new Map(
        Array.from({ length: window.sessionStorage.length }, (_, i) => {
          const k = window.sessionStorage.key(i);
          return [k, window.sessionStorage.getItem(k)];
        }),
      ),
  };
}
test("post list paginates and renders hostile input as text", async () => {
  const requests = [];
  const app = await page("index", {
    collection(name) {
      assert.equal(name, "posts");
      return {
        list: async (options) => {
          requests.push(options);
          return requests.length === 1
            ? {
                documents: [
                  {
                    id: "a",
                    data: {
                      title: "<img src=x onerror=alert(1)>",
                      body: "<script>bad()</script>",
                    },
                  },
                ],
                nextCursor: "a",
              }
            : { documents: [{ id: "b", data: null }], nextCursor: null };
        },
      };
    },
  });
  assert.equal(app.$("entries").querySelector("img,script"), null);
  assert.match(app.$("entries").textContent, /<img/);
  assert.equal(app.$("more").hidden, false);
  await app.fire("more", "click");
  assert.equal(requests[1].after, "a");
  assert.ok(
    requests.every((r) => r.orderBy === "created_at" && r.direction === "desc"),
  );
  assert.equal(app.$("entries").children.length, 2);
  assert.equal(app.$("more").hidden, true);
});
test("post detail reads selected ID and preserves plain text", async () => {
  const app = await page(
    "post",
    {
      collection: () => ({
        get: async (id) => {
          assert.equal(id, "hello");
          return { data: { title: "첫 글", body: "<b>본문</b>" } };
        },
      }),
    },
    new Map(),
    "?id=hello",
  );
  assert.equal(app.$("body").textContent, "<b>본문</b>");
  assert.equal(app.$("body").children.length, 0);
});
test("guestbook submits via add only and resets after success", async () => {
  const writes = [];
  const app = await page("guestbook", {
    collection(name) {
      assert.equal(name, "guestbook");
      return {
        list: async () => ({ documents: [], nextCursor: null }),
        add: async (data) => {
          writes.push(data);
          return { id: "generated" };
        },
      };
    },
  });
  app.$("name").value = " 방문자 ";
  app.$("message").value = " 안녕 ";
  await app.fire("entry-form", "submit");
  assert.equal(writes.length, 1);
  assert.equal(writes[0].message, "안녕");
  assert.equal(app.$("message").value, "");
  assert.equal(app.$("submit").disabled, false);
});
test("admin preserves draft across login, retries same ID, fails closed on expiry", async () => {
  let requested;
  const before = await page("admin", {
    completeOwnerSignIn: async () => null,
    signInAsOwner: async (options) => {
      requested = options;
    },
  });
  assert.equal(before.$("publish").disabled, true);
  before.$("title").value = "제목";
  before.$("body").value = "본문";
  await before.fire("login", "click");
  assert.equal(
    requested.redirectUri,
    "https://example.naru.pub/blog/admin.html",
  );
  assert.equal(requested.collections.join(), "posts");
  const writes = [];
  let failure = new Error("response lost");
  const owner = {
    expiresAt: Date.now() + 600000,
    collection(name) {
      assert.equal(name, "posts");
      return {
        set: async (id, data) => {
          writes.push({ id, data });
          if (failure) throw failure;
        },
      };
    },
  };
  const after = await page(
    "admin",
    { completeOwnerSignIn: async () => owner },
    before.storage(),
  );
  assert.equal(after.$("title").value, "제목");
  await after.fire("post-form", "submit");
  assert.equal(after.$("body").value, "본문");
  failure = null;
  await after.fire("post-form", "submit");
  assert.equal(writes[0].id, writes[1].id);
  assert.equal(after.$("view-post").hidden, false);
  assert.equal(after.storage().size, 0);
  after.$("title").value = "다음 글";
  after.$("body").value = "내용";
  failure = Object.assign(new Error("expired"), { status: 401 });
  await after.fire("post-form", "submit");
  assert.equal(after.$("publish").disabled, true);
  assert.equal(after.$("login").hidden, false);
  assert.equal(after.$("body").value, "내용");
});
test("admin clears local authorization when server revocation fails", async () => {
  const app = await page("admin", {
    completeOwnerSignIn: async () => ({
      expiresAt: Date.now() + 600000,
      signOut: async () => {
        throw new Error("offline");
      },
    }),
  });
  await app.fire("logout", "click");
  assert.equal(app.$("publish").disabled, true);
  assert.equal(app.$("login").hidden, false);
  assert.match(app.$("status").textContent, /서버 해제에 실패/);
});

test("guestbook distinguishes successful save from failed list refresh", async () => {
  let reads = 0;
  const app = await page("guestbook", {
    collection: () => ({
      list: async () => {
        if (++reads > 1) throw new Error("offline");
        return { documents: [], nextCursor: null };
      },
      add: async () => ({ id: "saved" }),
    }),
  });
  app.$("name").value = "방문자";
  app.$("message").value = "안녕";
  await app.fire("entry-form", "submit");
  assert.match(app.$("status").textContent, /저장되었지만/);
  assert.equal(app.$("message").value, "");
});

test("malformed draft does not prevent owner callback completion", async () => {
  let completed = false;
  const app = await page(
    "admin",
    {
      completeOwnerSignIn: async () => {
        completed = true;
        return { expiresAt: Date.now() + 600000 };
      },
    },
    new Map([["naru:blog-draft:example:/blog/admin.html", "invalid JSON"]]),
  );
  assert.equal(completed, true);
  assert.equal(app.$("publish").disabled, false);
  assert.match(app.$("status").textContent, /초안을 읽을 수 없습니다/);
});
