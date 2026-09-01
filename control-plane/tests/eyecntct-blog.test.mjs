// Run: node --experimental-vm-modules --test tests/eyecntct-blog.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { SourceTextModule, SyntheticModule } from "node:vm";
const require = createRequire(import.meta.url);
const { JSDOM } = createRequire(require.resolve("jest-environment-jsdom"))(
  "jsdom",
);
const root = new URL("../public/examples/eyecntct-blog/", import.meta.url);

// A stand-in for the database that records what the page asked for. The point
// of these tests is which queries the page issues, not how PostgreSQL answers.
function fakeDatabase({ posts = [], categories = [], guests = [] } = {}) {
  const calls = [];
  const store = new Map([
    ["posts", posts.map((post) => ({ version: 1, ...post }))],
    ["categories", categories.map((row) => ({ version: 1, ...row }))],
    ["guestbook", guests.map((row) => ({ version: 1, ...row }))],
  ]);
  const compare = (value, bounds) =>
    typeof value === "string" &&
    Object.entries(bounds).every(([operator, bound]) =>
      operator === "gte"
        ? value >= bound
        : operator === "gt"
          ? value > bound
          : operator === "lte"
            ? value <= bound
            : value < bound,
    );
  const matches = (document, where = {}) =>
    Object.entries(where).every(([field, condition]) =>
      condition && typeof condition === "object"
        ? compare(document.data?.[field], condition)
        : document.data?.[field] === condition,
    );
  const select = (name, { where, orderBy = "id", direction = "asc" } = {}) => {
    const key = orderBy.startsWith("data.") ? orderBy.slice(5) : orderBy;
    const rows = (store.get(name) ?? [])
      .filter((document) => matches(document, where))
      .sort((a, b) => {
        const [left, right] = [a, b].map((row) =>
          key === "id" ? row.id : (row.data?.[key] ?? row[key] ?? ""),
        );
        return (
          (left < right ? -1 : left > right ? 1 : 0) *
            (direction === "desc" ? -1 : 1) || (a.id < b.id ? -1 : 1)
        );
      });
    return rows;
  };
  const collection = (name) => ({
    async get(id) {
      calls.push({ method: "get", name, id });
      const found = (store.get(name) ?? []).find((row) => row.id === id);
      if (!found) throw Object.assign(new Error("404"), { status: 404 });
      return found;
    },
    async list(options = {}) {
      calls.push({ method: "list", name, ...options });
      const rows = select(name, options);
      return {
        documents: options.limit ? rows.slice(0, options.limit) : rows,
        nextCursor: null,
      };
    },
    async count(options = {}) {
      calls.push({ method: "count", name, ...options });
      return select(name, options).length;
    },
    async *all(options = {}) {
      calls.push({ method: "all", name, ...options });
      yield* select(name, options);
    },
    async add(data) {
      calls.push({ method: "add", name, data });
      const id = `generated-${(store.get(name) ?? []).length}`;
      store.get(name).push({ id, data, version: 1 });
      return { id, version: 1 };
    },
    async set(id, data, options = {}) {
      calls.push({ method: "set", name, id, data, ...options });
      const rows = store.get(name) ?? [];
      const index = rows.findIndex((row) => row.id === id);
      if (options.ifVersion !== undefined) {
        const version = index < 0 ? 0 : rows[index].version;
        if (options.ifVersion !== version)
          throw Object.assign(new Error("conflict"), {
            status: 409,
            code: "VERSION_CONFLICT",
          });
      }
      if (index < 0) rows.push({ id, data, version: 1 });
      else rows[index] = { id, data, version: rows[index].version + 1 };
      return { id };
    },
    async update(id, data, options = {}) {
      calls.push({ method: "update", name, id, data, ...options });
      const rows = store.get(name) ?? [];
      const row = rows.find((entry) => entry.id === id);
      if (!row) throw Object.assign(new Error("404"), { status: 404 });
      row.data = { ...row.data, ...data };
      for (const key of options.unset ?? []) delete row.data[key];
      row.version += 1;
      return { id };
    },
    async delete(id, options = {}) {
      calls.push({ method: "delete", name, id, ...options });
      store.set(
        name,
        (store.get(name) ?? []).filter((row) => row.id !== id),
      );
      return { success: true };
    },
  });
  const files = [];
  return {
    calls,
    store,
    files,
    collection,
    completeOwnerSignIn: async () => null,
    owner: {
      collection,
      batch: async (operations) => {
        calls.push({ method: "batch", operations });
        return { results: [] };
      },
      files: {
        list: async () => {
          calls.push({ method: "files.list" });
          return files;
        },
        delete: async (id) => {
          calls.push({ method: "files.delete", id });
          const index = files.findIndex((file) => file.id === id);
          files.splice(index, 1);
          return { success: true };
        },
      },
      signOut: async () => {},
    },
  };
}

async function page(database, { owner = false } = {}) {
  const dom = new JSDOM(await readFile(new URL("index.html", root), "utf8"), {
    url: "https://example.naru.pub/index.html",
    runScripts: "outside-only",
  });
  const { window } = dom;
  window.confirm = () => true;
  // JSDOM ships neither dialogs nor randomUUID; the page needs both.
  window.HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  window.HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
  window.crypto.randomUUID = () => "generated-id";
  const context = dom.getInternalVMContext();
  if (owner) database.completeOwnerSignIn = async () => database.owner;
  const config = new SyntheticModule(
    ["config"],
    function () {
      this.setExport("config", { site: "example" });
    },
    { context },
  );
  const sdk = new SyntheticModule(
    ["createDatabase"],
    function () {
      this.setExport("createDatabase", () => database);
    },
    { context },
  );
  const app = new SourceTextModule(
    await readFile(new URL("app.js", root), "utf8"),
    {
      context,
      importModuleDynamically: async () => {
        await sdk.link(() => {
          throw new Error("no imports");
        });
        if (sdk.status !== "evaluated") await sdk.evaluate();
        return sdk;
      },
    },
  );
  await app.link(async () => config);
  await app.evaluate();
  return {
    window,
    $: (id) => window.document.getElementById(id),
    click: (id) => window.document.getElementById(id).onclick({}),
    settle: () => new Promise((resolve) => setTimeout(resolve, 0)),
  };
}

const post = (id, date, data = {}) => ({
  id,
  data: { title: id, date, bodyMarkdown: `${id} 본문`, ...data },
  created_at: "2026-01-01T00:00:00.000Z",
  version: 1,
});

test("recent records sort on the author's date, not on write order", async () => {
  // "old" was written last but backdated, so write order would misplace it.
  const db = fakeDatabase({
    posts: [
      post("old", "2020-01-01"),
      post("newest", "2026-09-20"),
      post("middle", "2026-09-10"),
    ],
  });
  const view = await page(db);
  await view.settle();
  const recent = db.calls.find(
    (call) => call.method === "list" && call.name === "posts",
  );
  assert.equal(recent.orderBy, "data.date");
  assert.equal(recent.direction, "desc");
  assert.equal(recent.limit, 8);
  const titles = [...view.$("featuredPosts").querySelectorAll("h3")].map(
    (node) => node.textContent,
  );
  assert.deepEqual(titles, ["newest", "middle", "old"]);
});

test("the calendar asks for its visible weeks instead of every record", async () => {
  const db = fakeDatabase({ posts: [post("inside", "2026-09-10")] });
  const view = await page(db);
  await view.settle();
  const month = db.calls.find(
    (call) => call.method === "all" && call.name === "posts",
  );
  assert.equal(typeof month.where.date.gte, "string");
  assert.equal(typeof month.where.date.lte, "string");
  // Six weeks of cells, so the window is wider than the month itself.
  const span =
    (new Date(month.where.date.lte) - new Date(month.where.date.gte)) /
    86400000;
  assert.equal(span, 41);
  const before = db.calls.length;
  view.click("previousMonth");
  await view.settle();
  const next = db.calls
    .slice(before)
    .filter((call) => call.method === "all" && call.name === "posts");
  // Moving a month is one new range query, not a refetch of everything.
  assert.equal(next.length, 1);
  assert.ok(next[0].where.date.gte < month.where.date.gte);
});

test("the record total comes from count(), not from the loaded page", async () => {
  const db = fakeDatabase({
    posts: Array.from({ length: 30 }, (_, i) =>
      post(`p${i}`, `2026-09-${String((i % 28) + 1).padStart(2, "0")}`, {
        categoryId: i < 12 ? "diary" : "notes",
      }),
    ),
    categories: [
      { id: "diary", data: { name: "일기", color: "#112233" } },
      { id: "notes", data: { name: "메모", color: "#445566" } },
    ],
  });
  const view = await page(db);
  await view.settle();
  const total = db.calls.find((call) => call.method === "count");
  assert.equal(total.name, "posts");
  const filter = view.$("categoryFilter");
  filter.value = "diary";
  await filter.onchange({ currentTarget: filter });
  const scoped = db.calls.filter((call) => call.method === "count").at(-1);
  assert.deepEqual({ ...scoped.where }, { categoryId: "diary" });
  // 12 matching records, well past the 8 the page actually holds.
  assert.match(view.$("status").textContent, /12개 기록/);
  assert.equal(view.$("featuredPosts").querySelectorAll("h3").length, 8);
  const month = db.calls.filter((call) => call.method === "all").at(-1);
  assert.equal(month.where.categoryId, "diary");
});

test("owners migrate legacy categories by merging, not by rewriting records", async () => {
  const db = fakeDatabase({
    posts: [
      post("legacy", "2026-09-01", {
        category: "일기",
        categoryColor: "#112233",
      }),
    ],
  });
  const view = await page(db, { owner: true });
  await view.settle();
  const patch = db.calls.find((call) => call.method === "update");
  assert.equal(patch.name, "posts");
  assert.deepEqual({ ...patch.data }, { categoryId: "generated-id" });
  assert.deepEqual([...patch.unset], ["category", "categoryColor"]);
  assert.equal(patch.ifVersion, 1);
  const stored = db.store.get("posts")[0].data;
  // The body survived a migration that never sent it.
  assert.equal(stored.bodyMarkdown, "legacy 본문");
  assert.equal(stored.categoryId, "generated-id");
  assert.ok(!("category" in stored) && !("categoryColor" in stored));
});

test("saving quotes the version the editor opened and reports a conflict", async () => {
  const db = fakeDatabase({
    posts: [post("one", "2026-09-01", { categoryId: "diary" })],
    categories: [{ id: "diary", data: { name: "일기", color: "#112233" } }],
  });
  const view = await page(db, { owner: true });
  await view.settle();
  view.$("featuredPosts").querySelector("button").onclick();
  view.$("editCurrentPost").click();
  await view.settle();
  view.$("titleInput").value = "고친 제목";
  await view.$("editorForm").onsubmit({ preventDefault() {} });
  await view.settle();
  const saved = db.calls.filter((call) => call.method === "set").at(-1);
  assert.equal(saved.id, "one");
  assert.equal(saved.ifVersion, 1);
  assert.equal(db.store.get("posts")[0].data.title, "고친 제목");
  // Someone else saves, then this stale editor tries again.
  db.store.get("posts")[0].version = 9;
  await view.$("editorForm").onsubmit({ preventDefault() {} });
  await view.settle();
  assert.match(view.$("status").textContent, /다른 곳에서 먼저 저장/);
});

test("deleting a record takes the images only it referenced", async () => {
  const db = fakeDatabase({
    posts: [post("one", "2026-09-01", { categoryId: "diary" })],
    categories: [{ id: "diary", data: { name: "일기", color: "#112233" } }],
  });
  db.files.push(
    {
      id: "own",
      metadata: { references: [{ collection: "posts", id: "one" }] },
    },
    {
      id: "shared",
      metadata: {
        references: [
          { collection: "posts", id: "one" },
          { collection: "posts", id: "two" },
        ],
      },
    },
    { id: "unrelated", metadata: { references: [] } },
  );
  const view = await page(db, { owner: true });
  await view.settle();
  view.$("featuredPosts").querySelector("button").onclick();
  view.$("editCurrentPost").click();
  await view.settle();
  view.click("deleteButton");
  await view.settle();
  const removed = db.calls
    .filter((call) => call.method === "files.delete")
    .map((call) => call.id);
  // Only the file no other record still points at is collected.
  assert.deepEqual(removed, ["own"]);
  assert.deepEqual(
    db.files.map((file) => file.id),
    ["shared", "unrelated"],
  );
  assert.equal(db.store.get("posts").length, 0);
});
