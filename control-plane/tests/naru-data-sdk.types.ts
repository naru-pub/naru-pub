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
// @ts-expect-error Only metadata sort fields are supported.
posts.list({ orderBy: "title" });
async function owner() {
  const admin = await db.completeOwnerSignIn();
  if (admin) {
    const result = await admin.collection<Post>("posts").list();
    const title: string = result.documents[0].data.title;
    await admin.signOut();
  }
}
const error: Error = new NaruDataError(0, "Network failure");
