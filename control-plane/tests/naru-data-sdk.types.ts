import {
  createDatabase,
  type Document,
  NaruDataError,
} from "../public/sdk/1.0.0/naru-data.js";
interface Post {
  title: string;
  published: boolean;
}
const db = createDatabase({ site: "alice" });
const posts = db.collection<Post>("posts");
const post: Promise<Document<Post>> = posts.get("one");
posts.add({ title: "hello", published: false });
// @ts-expect-error Wrong field type.
posts.set("one", { title: 123, published: false });
// @ts-expect-error Full replacement requires all fields.
posts.set("one", { title: "hello" });
// @ts-expect-error Sorting on a document field needs the data. prefix.
posts.list({ orderBy: "title" });
posts.list({ orderBy: "data.title", direction: "desc" });
posts.list({ where: { published: true, title: { gte: "a", lt: "b" } } });
// @ts-expect-error Range bounds are strings or numbers, never booleans.
posts.list({ where: { published: { gte: true } } });
// @ts-expect-error Only gt, gte, lt and lte are comparison operators.
posts.list({ where: { title: { contains: "hello" } } });
const total: Promise<number> = posts.count({ where: { published: true } });
async function page() {
  for await (const document of posts.all({ orderBy: "data.title" })) {
    const title: string = document.data.title;
  }
}
async function owner() {
  const admin = await db.completeOwnerSignIn();
  if (admin) {
    const result = await admin.collection<Post>("posts").list();
    const title: string = result.documents[0].data.title;
    await admin.signOut();
  }
}
const error: Error = new NaruDataError(0, "Network failure");

const requestOptions = {
  signal: new AbortController().signal,
  timeoutMs: 1000,
};
posts.get("one", requestOptions);
posts.list(requestOptions);
posts.count(requestOptions);
posts.all(requestOptions);
posts.add({ title: "hello", published: true }, requestOptions);
posts.set(
  "one",
  { title: "hello", published: true },
  { ...requestOptions, ifVersion: 1 },
);
posts.update(
  "one",
  { title: "hello" },
  { ...requestOptions, unset: ["published"] },
);
posts.delete("one", requestOptions);
db.signInAsOwner({ ...requestOptions, collections: ["posts"] });
db.completeOwnerSignIn(requestOptions).then((admin) => {
  if (!admin) return;
  admin.files.get("one", requestOptions);
  admin.files.list(requestOptions);
  admin.files.usage(requestOptions);
  admin.files.upload(new Blob(["hello"]), {
    ...requestOptions,
    onProgress: ({ loaded }) => void loaded,
    image: { maxDimension: 1600, quality: 0.7, type: "image/jpeg" },
  });
  admin.files.upload(new Blob(["hello"]), { original: true });
  admin.files.delete("one", requestOptions);
  admin.batch(
    [{ type: "delete", collection: "posts", id: "one" }],
    requestOptions,
  );
  admin.signOut(requestOptions);
});
// @ts-expect-error Timeouts are milliseconds, not duration strings.
posts.get("one", { timeoutMs: "1s" });
// @ts-expect-error A controller is not a signal.
posts.list({ signal: new AbortController() });

// @ts-expect-error Write validators moved into collections.<name>.parse.
createDatabase({ site: "alice", schemas: { posts: () => true } });
// @ts-expect-error Parsing is registered once, not per handle.
db.collection("posts", { parse: () => ({ title: "hello" }) });

// Query fields, equality values and range domains follow the collection type.
// @ts-expect-error Misspelled field.
posts.list({ where: { titel: "hello" } });
// @ts-expect-error String fields cannot be compared to numbers.
posts.count({ where: { title: 42 } });
// @ts-expect-error Boolean fields do not support ranges.
posts.list({ where: { published: { gt: 0 } } });
// @ts-expect-error Unknown sort field.
posts.all({ orderBy: "data.titel" });
// @ts-expect-error String ranges cannot use numeric boundaries.
posts.list({ where: { title: { gte: 1 } } });
posts.list({ orderBy: "createdAt" });
posts.list({ where: {} });

interface Article {
  score?: number | null;
  status: "draft" | "published";
  mixed: string | number;
  tags: string[];
  author: { name: string };
}
const articles = db.collection<Article>("articles");
articles.list({
  where: { score: null, status: "draft", mixed: { gt: 1, lt: 10 } },
});
articles.count({ where: { score: { gt: 1 }, mixed: { gte: "a" } } });
articles.list({ orderBy: "data.author" });
// Range boundaries need not be stored literal values.
articles.list({ where: { status: { gt: "a", lt: "z" } } });
// @ts-expect-error Equality preserves string literals.
articles.list({ where: { status: "deleted" } });
// @ts-expect-error Optional numbers do not become strings.
articles.list({ where: { score: "5" } });
// @ts-expect-error Both bounds must use the same JSONB domain.
articles.list({ where: { mixed: { gt: "a", lt: 3 } } });
// @ts-expect-error Array equality is unsupported.
articles.list({ where: { tags: ["x"] } });
// @ts-expect-error Object equality is unsupported.
articles.list({ where: { author: { name: "a" } } });
// @ts-expect-error No nested paths.
articles.list({ orderBy: "data.author.name" });
// @ts-expect-error No nested filter paths.
articles.list({ where: { "author.name": "a" } });

const events = db.collection<
  { kind: "a"; a: number } | { kind: "b"; b: string }
>("events");
events.list({ where: { a: 1, b: "two" }, orderBy: "data.b" });
// @ts-expect-error Union-specific fields retain their types.
events.list({ where: { b: 1 } });
const scalar = db.collection<string>("scalar");
scalar.list({ where: {}, orderBy: "id" });
// @ts-expect-error Scalars have no document fields.
scalar.list({ where: { length: 1 } });
// @ts-expect-error Arrays have no sortable document fields.
db.collection<string[]>("array").list({ orderBy: "data.length" });

import type {
  Filter,
  ListOptions,
  OrderBy,
  QueryOptions,
  RangeFilter,
  BatchOperation,
  Written,
  OwnerDatabase,
  Json,
} from "../public/sdk/1.0.0/naru-data.js";
const query: QueryOptions<Post> = {
  where: { title: "hello" },
  orderBy: "data.title",
};
posts.list(query);
const listing: ListOptions<Post> = { ...query, limit: 10 };
posts.all(listing);
const filter: Filter<Post> = { published: false };
const sort: OrderBy<Post> = "data.title";
const range: RangeFilter<number> = { gt: 1 };
// Untyped and explicitly broad clients retain flexible field names.
const loose: Filter = { anything: true, number: { gt: 1 }, text: { lt: "z" } };
db.collection("loose").list({ where: loose, orderBy: "data.anything" });
db.collection<unknown>("unknown").count({ where: loose });
db.collection<Record<string, number>>("scores").list({
  where: { arbitrary: { gt: 0 } },
});
db.collection<Record<string, number>>("scores").list({
  // @ts-expect-error Open records still constrain field values.
  where: { arbitrary: "bad" },
});

async function batchTypes(admin: OwnerDatabase) {
  const { results } = await admin.batch([
    { type: "add", collection: "posts", data: { tags: ["a", "b"] } },
    { type: "set", collection: "posts", id: "one", data: {} },
    {
      type: "update",
      collection: "posts",
      id: "two",
      data: {},
      unset: ["title"],
    },
    { type: "delete", collection: "posts", id: "three" },
  ]);
  const added: Written = results[0];
  const version: number = results[1].version;
  const updated: string = results[2].id;
  const deleted: true = results[3].success;
  // @ts-expect-error Delete results contain no version.
  results[3].version;
  // @ts-expect-error Write results contain no success flag.
  results[0].success;
  // @ts-expect-error Result tuple preserves length.
  results[4];
  const fixed = [{ type: "delete", collection: "posts", id: "one" }] as const;
  const fixedResult: true = (await admin.batch(fixed)).results[0].success;
  const operations: BatchOperation[] = [];
  const dynamic = (await admin.batch(operations)).results;
  for (const item of dynamic) {
    if ("success" in item) {
      const success: true = item.success;
    } else {
      const version: number = item.version;
    }
  }
  // @ts-expect-error Dynamic results need narrowing.
  dynamic[0].version;
}

// Existing standalone query types remain usable without a document type.
const broadRange: RangeFilter = { gt: 1 };
const broadList: ListOptions = {
  where: { value: broadRange },
  orderBy: "data.value",
};
db.collection("loose").list(broadList);

const registered = createDatabase({
  site: "alice",
  collections: {
    posts: {
      parse(data) {
        if (
          !data ||
          typeof data !== "object" ||
          Array.isArray(data) ||
          typeof data.title !== "string"
        )
          throw new Error("invalid title");
        return { title: data.title };
      },
    },
    cards: {
      parse: (data): Post => data as unknown as Post,
      map: (document: Document<Post>) => ({
        ...document.data,
        id: document.id,
      }),
    },
    flags: { parse: () => false },
  },
});
const parsedPosts = registered.collection("posts");
parsedPosts.get("one").then((document) => {
  const title: string = document.data.title;
  // @ts-expect-error Parser output determines the document type.
  document.data.missing;
});
parsedPosts.list({ where: { title: "hello" }, orderBy: "data.title" });
parsedPosts.add({ title: "hello" });
// @ts-expect-error Writes take the parsed shape.
parsedPosts.add({ heading: "hello" });
// @ts-expect-error Inferred fields constrain queries too.
parsedPosts.count({ where: { title: 42 } });
registered
  .collection("cards")
  .list({ pageToken: null })
  .then(({ documents }) => {
    // map output replaces the document, with server metadata folded in.
    const id: string = documents[0].id;
    const published: boolean = documents[0].published;
  });
registered
  .collection("flags")
  .get("one")
  .then((document) => {
    const flag: boolean = document.data;
  });
// Unregistered names on a registered client stay untyped JSON.
registered
  .collection("other")
  .get("one")
  .then((document) => {
    const data: Json = document.data;
  });
registered.completeOwnerSignIn().then((admin) => {
  if (!admin) return;
  // The owner client carries the same registry.
  admin
    .collection("cards")
    .get("one")
    .then((card) => {
      const title: string = card.title;
    });
  const deadline: number = admin.session.expiresAt;
  // @ts-expect-error The deadline lives on session.
  admin.expiresAt;
});
createDatabase({
  site: "alice",
  // @ts-expect-error Asynchronous parsers are unsupported.
  collections: { posts: { parse: async () => ({ title: "hello" }) } },
});
createDatabase({
  site: "alice",
  // @ts-expect-error Promise-returning functions are unsupported too.
  collections: { posts: { parse: () => Promise.resolve({ title: "hello" }) } },
});
createDatabase({
  site: "alice",
  // @ts-expect-error Writes store the application's JSON, so there is no serializer.
  collections: { posts: { serialize: () => ({}) } },
});
createDatabase({
  site: "alice",
  collections: {
    posts: {
      parse: (data): Post => data as unknown as Post,
      // @ts-expect-error An unannotated map has no document type to read from.
      map: (document) => document.data.title,
    },
  },
});

// Untyped collections may remove arbitrary top-level JSON fields.
db.collection("schemaless").update("one", {}, { unset: ["legacy"] });
// @ts-expect-error Typed collections still reject unknown field names in unset.
posts.update("one", {}, { unset: ["legacy"] });

db.completeOwnerSignIn().then((admin) => {
  // @ts-expect-error Only the three encodable types can be produced.
  admin?.files.upload(new Blob(["hello"]), { image: { type: "image/gif" } });
  // @ts-expect-error Opting out is a boolean, not a falsy image option.
  admin?.files.upload(new Blob(["hello"]), { image: false });
});
