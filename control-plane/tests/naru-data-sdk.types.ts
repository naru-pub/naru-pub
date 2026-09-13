import {
  collection,
  type Document,
  type Json,
  NaruDataError,
  type Owner,
  ownerSession,
  signIn,
  type StoredFile,
  type Written,
} from "../public/sdk/1.0.0/naru-data.js";

interface Post {
  title: string;
  published: boolean;
}
const posts = collection<Post>("posts");
const other = collection("posts", { site: "alice" });
const signal = new AbortController().signal;

const post: Promise<Document<Post>> = posts.get("one", { signal });
posts.add({ title: "hello", published: false });
// @ts-expect-error Wrong field type.
posts.set("one", { title: 123, published: false });
// @ts-expect-error Full replacement requires all fields.
posts.set("one", { title: "hello" });
const written: Promise<Written> = posts.set(
  "one",
  { title: "hello", published: true },
  { ifVersion: 0, signal },
);
const deleted: Promise<void> = posts.delete("one", { ifVersion: 1 });

async function page() {
  let pageToken: string | null = null;
  do {
    const result = await posts.list({
      where: { published: true, title: { gte: "a", lt: "b" } },
      orderBy: [
        ["data.title", "asc"],
        ["createdAt", "desc"],
      ],
      limit: 20,
      pageToken,
      includeTotal: true,
      signal,
    });
    const title: string = result.documents[0].data.title;
    const total: number | undefined = result.total;
    pageToken = result.nextPageToken;
  } while (pageToken);
  const loose: Json = (await other.get("one")).data;
}
// @ts-expect-error orderBy is always a list of [field, direction] pairs.
posts.list({ orderBy: "createdAt" });
posts.list({
  orderBy: [
    ["a", "asc"],
    ["b", "asc"],
    // @ts-expect-error At most two sort keys.
    ["c", "asc"],
  ],
});
// @ts-expect-error Arrays are not filter values.
posts.list({ where: { tags: ["x"] } });
// @ts-expect-error Merge patches are not part of the API.
posts.update("one", { title: "x" });
// @ts-expect-error Counting rides along with list via includeTotal.
posts.count();

async function owner() {
  const admin: Owner | null = await ownerSession({ site: "alice" });
  if (!admin) return signIn({ collections: ["posts"] });
  const deadline: number = admin.expiresAt;
  const drafts = admin.collection<Post>("drafts");
  await drafts.set("one", { title: "draft", published: false });
  const results = await admin.batch([
    { type: "add", collection: "logs", data: { at: "now" } },
    { type: "set", collection: "posts", id: "one", data: {}, ifVersion: 0 },
    { type: "delete", collection: "drafts", id: "one" },
  ]);
  for (const result of results)
    if ("success" in result) {
      const success: true = result.success;
    } else {
      const version: number = result.version;
    }
  admin.batch([
    // @ts-expect-error Batches add, set and delete; nothing merges.
    { type: "update", collection: "posts", id: "one", data: {} },
  ]);
  const file: StoredFile = await admin.files.upload(new Blob(["x"]), {
    signal,
  });
  const url: string = file.url;
  // @ts-expect-error Uploads carry no metadata to find them by.
  admin.files.upload(new Blob(["x"]), { metadata: { postId: "one" } });
  const listing = await admin.files.list({ limit: 20, pageToken: null });
  // @ts-expect-error The library is not filtered by what files belong to.
  admin.files.list({ where: { postId: "one" } });
  const files: StoredFile[] = listing.files;
  await admin.files.delete(file.id);
  // @ts-expect-error Image settings are fixed.
  admin.files.upload(new Blob(["x"]), { image: { maxDimension: 800 } });
  await admin.signOut();
}

const error: Error = new NaruDataError(409, "Conflict", "VERSION_CONFLICT");
