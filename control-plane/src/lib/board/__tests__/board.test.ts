/** @jest-environment node */
import { resetLedgerFixtures } from "@/test-support/ledger-fixtures";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  jest,
  test,
} from "@jest/globals";

// An in-memory bucket stands in for R2: keys to content types.
const bucket = new Map<string, { size: number; contentType: string }>();
jest.mock("../storage", () => ({
  listObjects: jest.fn(async (prefix: string) =>
    [...bucket]
      .filter(([key]) => key.startsWith(prefix))
      .map(([key, value]) => ({ key, size: value.size })),
  ),
  copyObject: jest.fn(
    async (source: string, target: string, contentType?: string) => {
      const object = bucket.get(source);
      if (!object) throw new Error(`no such key: ${source}`);
      bucket.set(target, {
        size: object.size,
        contentType: contentType ?? object.contentType,
      });
    },
  ),
  deleteObjects: jest.fn(async (keys: string[]) => {
    for (const key of keys) bucket.delete(key);
  }),
  deletePrefix: jest.fn(async (prefix: string) => {
    for (const key of [...bucket.keys()]) {
      if (key.startsWith(prefix)) bucket.delete(key);
    }
  }),
  purgeSiteFiles: jest.fn(async () => {}),
}));
// Hourly limits would trip over this many posts from one person.
jest.mock("../limits", () => ({
  assertUnderHourlyLimit: jest.fn(async () => {}),
}));
jest.mock("@/lib/entitlements", () => ({
  getUserFeatures: jest.fn(async () => new Set(["database"])),
}));

// Required after the mocks: this transform does not hoist jest.mock above
// imports.
import type { User } from "@/lib/auth";
const { sql } = require("kysely") as typeof import("kysely");
const { getUserFeatures } = require("@/lib/entitlements") as {
  getUserFeatures: jest.Mock<
    typeof import("@/lib/entitlements").getUserFeatures
  >;
};
const { db } = require("@/lib/database") as typeof import("@/lib/database");
const { BoardError } = require("../errors") as typeof import("../errors");
const {
  createPost,
  deletePost,
  getPost,
  listLatestPosts,
  listPosts,
  setPostLike,
  setSolvedReply,
} = require("../posts") as typeof import("../posts");
const {
  countUnreadNotifications,
  createReply,
  deleteReply,
  listReplies,
  markPostNotificationsRead,
} = require("../replies") as typeof import("../replies");
const {
  listPostsForModeration,
  listRepliesForModeration,
  restorePost,
  restoreReply,
} = require("../moderation") as typeof import("../moderation");
const {
  applyTemplate,
  commonDirectory,
  deleteTemplateObjects,
  getTemplateForPost,
  planApplication,
  publishTemplatePost,
  publishTemplateVersion,
} = require("../templates") as typeof import("../templates");
// Site databases are Durable Objects: the script starts a local Worker.
const { createCollections, listCollections } =
  require("@/lib/site-data/service") as typeof import("@/lib/site-data/service");
const { eraseSiteData } =
  require("@/lib/edge/client") as typeof import("@/lib/edge/client");

// Runs against a disposable, migrated database (scripts/test-board.sh), never
// the developer's own.
const integration =
  process.env.NARU_BOARD_TEST === "1" ? describe : describe.skip;

async function makeUser(loginName: string, verified = true): Promise<User> {
  const row = await db
    .insertInto("users")
    .values({
      login_name: loginName,
      password_hash: "x",
      email: `${loginName}@example.com`,
      email_verified_at: verified ? new Date() : null,
    })
    .returning(["id", "created_at"])
    .executeTakeFirstOrThrow();
  return {
    id: row.id,
    loginName,
    createdAt: row.created_at,
    email: `${loginName}@example.com`,
    emailVerifiedAt: verified ? new Date() : null,
    discoverable: false,
  };
}

function put(key: string, contentType = "text/html", size = 10) {
  bucket.set(key, { size, contentType });
}

integration("board", () => {
  let alice: User;
  let bob: User;
  let carol: User;

  beforeAll(async () => {
    await resetLedgerFixtures(
      db,
      sql`truncate users, board_posts restart identity cascade`,
    );
    alice = await makeUser("alice");
    bob = await makeUser("bob");
    carol = await makeUser("carol");
    for (const user of [alice, bob, carol]) await eraseSiteData(user.loginName);
  });

  afterAll(async () => {
    await db.destroy();
  });

  beforeEach(() => {
    bucket.clear();
  });

  describe("posts", () => {
    test("lists by activity, filters by kind, and hides deleted posts", async () => {
      const first = await createPost(alice, {
        kind: "chat",
        title: "첫 글",
        body: "안녕하세요",
      });
      const second = await createPost(bob, {
        kind: "question",
        title: "질문",
        body: "도메인이 안 돼요",
      });
      expect(first).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
      await createReply(carol, first, { parentId: null, body: "반가워요" });

      const all = await listPosts({ kind: null, sort: "activity", page: 1 });
      expect(all.posts.map((p) => p.id).slice(0, 2)).toEqual([first, second]);
      expect(all.posts[0].lastReplyLoginName).toBe("carol");

      const questions = await listPosts({
        kind: "question",
        sort: "new",
        page: 1,
      });
      expect(questions.posts.map((p) => p.id)).toEqual([second]);

      await deletePost(bob, second);
      expect(await getPost(second, null)).toBeNull();
      const after = await listPosts({ kind: null, sort: "new", page: 1 });
      expect(after.posts.map((p) => p.id)).not.toContain(second);
    });

    test("only the author or an admin deletes a post", async () => {
      const id = await createPost(alice, {
        kind: "chat",
        title: "지우지 마세요",
        body: "본문",
      });
      await expect(deletePost(bob, id)).rejects.toMatchObject({ status: 403 });
      const yang = await makeUser("yang");
      await expect(deletePost(yang, id)).resolves.toBeDefined();
    });

    test("likes count once per person", async () => {
      const id = await createPost(alice, {
        kind: "site",
        title: "내 사이트",
        body: "",
      });
      expect(await setPostLike(bob, id, true)).toBe(1);
      expect(await setPostLike(bob, id, true)).toBe(1);
      expect(await setPostLike(carol, id, true)).toBe(2);
      expect(await setPostLike(bob, id, false)).toBe(1);
      expect((await getPost(id, carol))?.likedByViewer).toBe(true);
    });

    test("validates titles and required bodies", async () => {
      await expect(
        createPost(alice, { kind: "chat", title: "  ", body: "x" }),
      ).rejects.toBeInstanceOf(BoardError);
      await expect(
        createPost(alice, { kind: "question", title: "제목", body: "" }),
      ).rejects.toMatchObject({ status: 400 });
    });
  });

  describe("replies", () => {
    test("returns the tree in display order with depth", async () => {
      const post = await createPost(alice, {
        kind: "chat",
        title: "스레드",
        body: "본문",
      });
      const a = await createReply(bob, post, { parentId: null, body: "a" });
      const b = await createReply(carol, post, { parentId: null, body: "b" });
      const a1 = await createReply(alice, post, { parentId: a, body: "a1" });
      const a1x = await createReply(bob, post, { parentId: a1, body: "a1x" });
      const a2 = await createReply(carol, post, { parentId: a, body: "a2" });

      const { replies } = await listReplies(post, null);
      expect(replies.map((r) => [r.body, r.depth])).toEqual([
        ["a", 0],
        ["a1", 1],
        ["a1x", 2],
        ["a2", 1],
        ["b", 0],
      ]);
      expect(replies.find((r) => r.id === a2)?.parentId).toBe(a);

      const subtree = await listReplies(post, null, a1);
      expect(subtree.replies.map((r) => r.id)).toEqual([a1, a1x]);
      expect(b).toBeDefined();
      expect((await getPost(post, null))?.replyCount).toBe(5);
    });

    test("replies past the deepest level join their parent's siblings", async () => {
      const post = await createPost(alice, {
        kind: "chat",
        title: "깊은 스레드",
        body: "본문",
      });
      let parent: string | null = null;
      const ids: string[] = [];
      for (let depth = 0; depth < 5; depth++) {
        parent = await createReply(bob, post, {
          parentId: parent,
          body: `d${depth}`,
        });
        ids.push(parent);
      }
      const deeper = await createReply(carol, post, {
        parentId: ids[4],
        body: "too deep",
      });
      const { replies } = await listReplies(post, null);
      const reply = replies.find((r) => r.id === deeper)!;
      expect(reply.depth).toBe(4);
      expect(reply.parentId).toBe(ids[3]);
      // The person answered is still the one notified.
      const unread = await countUnreadNotifications(bob.id);
      expect(unread.from).toContain("carol");
    });

    test("notifies the post author and the parent's author once each", async () => {
      await sql`delete from board_notifications`.execute(db);
      const post = await createPost(alice, {
        kind: "chat",
        title: "알림",
        body: "본문",
      });
      const top = await createReply(bob, post, { parentId: null, body: "top" });
      // Carol answers Bob: Bob for the reply, Alice for the post.
      await createReply(carol, post, { parentId: top, body: "answer" });
      // Alice answers her own thread's reply: only Bob.
      await createReply(alice, post, { parentId: top, body: "thanks" });

      expect((await countUnreadNotifications(alice.id)).count).toBe(2);
      expect((await countUnreadNotifications(bob.id)).count).toBe(2);
      expect((await countUnreadNotifications(carol.id)).count).toBe(0);

      await markPostNotificationsRead(alice.id, post);
      expect((await countUnreadNotifications(alice.id)).count).toBe(0);
    });

    test("a deleted reply stays as a placeholder only while it has replies", async () => {
      const post = await createPost(alice, {
        kind: "question",
        title: "해결",
        body: "본문",
      });
      const parent = await createReply(bob, post, {
        parentId: null,
        body: "p",
      });
      const child = await createReply(carol, post, {
        parentId: parent,
        body: "c",
      });
      const lone = await createReply(carol, post, {
        parentId: null,
        body: "l",
      });
      await setSolvedReply(alice, post, child);

      await deleteReply(bob, parent);
      await deleteReply(carol, lone);
      await expect(deleteReply(bob, child)).rejects.toMatchObject({
        status: 403,
      });

      const { replies } = await listReplies(post, null);
      expect(replies.map((r) => [r.id, r.body])).toEqual([
        [parent, null],
        [child, "c"],
      ]);
      expect((await getPost(post, null))?.replyCount).toBe(1);

      await deleteReply(carol, child);
      expect((await getPost(post, null))?.solvedReplyId).toBeNull();
    });
  });

  describe("moderation", () => {
    test("admins see deleted posts and replies and can restore them", async () => {
      const yang = await makeUser("yang-mod");
      // isBoardAdmin checks the operator list, so borrow its one name.
      const admin = { ...yang, loginName: "yang" };

      const post = await createPost(alice, {
        kind: "chat",
        title: "지울 글",
        body: "본문",
      });
      const reply = await createReply(bob, post, {
        parentId: null,
        body: "지울 답글",
      });
      await deleteReply(admin, reply);
      await deletePost(admin, post);

      const deletedPosts = await listPostsForModeration({
        status: "deleted",
        author: "alice",
        page: 1,
      });
      expect(deletedPosts.posts.map((p) => p.id)).toContain(post);
      const deletedReplies = await listRepliesForModeration({
        status: "deleted",
        author: "bob",
        page: 1,
      });
      expect(deletedReplies.replies.map((r) => r.id)).toContain(reply);

      await expect(restorePost(bob, post)).rejects.toMatchObject({
        status: 403,
      });
      await restorePost(admin, post);
      await restoreReply(admin, reply);
      expect((await getPost(post, null))?.replyCount).toBe(1);
      await expect(restoreReply(admin, reply)).rejects.toMatchObject({
        status: 404,
      });
    });

    test("a deleted template can't be restored", async () => {
      put("alice/tpl/index.html");
      const { postId } = await publishTemplatePost(alice, {
        title: "템플릿",
        body: "",
        slug: "mod-tpl",
        cc0Accepted: true,
        files: ["tpl/index.html"],
        collections: [],
      });
      await deletePost(alice, postId);
      const admin = { ...alice, loginName: "yang" };
      await expect(restorePost(admin, postId)).rejects.toMatchObject({
        status: 409,
      });
      const listed = await listPostsForModeration({
        status: "deleted",
        author: null,
        page: 1,
      });
      expect(listed.posts.find((p) => p.id === postId)?.restorable).toBe(false);
    });
  });

  describe("templates", () => {
    // Everything under alice/retro/ unless a test checks other files.
    function aliceFiles(prefix = "retro/") {
      return [...bucket.keys()]
        .filter((key) => key.startsWith(`alice/${prefix}`))
        .map((key) => key.slice("alice/".length));
    }

    function publish(overrides: Record<string, unknown> = {}) {
      return publishTemplatePost(alice, {
        title: "레트로 홈",
        body: "설명",
        slug: `retro-${Math.random().toString(36).slice(2, 8)}`,
        cc0Accepted: true,
        files: aliceFiles(),
        collections: [],
        ...overrides,
      });
    }

    test("requires explicit CC0 consent and fixes the license server-side", async () => {
      put("alice/retro/index.html");
      for (const cc0Accepted of [undefined, false, "true", 1]) {
        await expect(publish({ cc0Accepted })).rejects.toMatchObject({
          status: 400,
        });
      }
      const { postId } = await publish({ license: "cc-by-4.0" });
      expect((await getTemplateForPost(postId))?.license).toBe("cc0-1.0");
    });

    test("publishing a version preserves an existing template's license", async () => {
      put("alice/retro/index.html");
      const { postId, templateId } = await publish();
      await db
        .updateTable("board_templates")
        .set({ license: "cc-by-sa-4.0" })
        .where("id", "=", templateId)
        .execute();
      await publishTemplateVersion(alice, templateId, {
        files: aliceFiles(),
        changelog: "업데이트",
        collections: [],
      });
      expect((await getTemplateForPost(postId))?.license).toBe("cc-by-sa-4.0");
    });

    test("publishes a snapshot of only the checked files", async () => {
      put("alice/retro/index.html");
      put("alice/retro/style.css", "text/css");
      put("alice/retro/images/bg.png", "image/png", 100);
      put("alice/retro/drafts/secret.html");
      put("alice/index.html");

      const { postId, templateId } = await publish({
        files: ["retro/index.html", "retro/style.css", "retro/images/bg.png"],
      });
      const template = await getTemplateForPost(postId);
      expect(template?.files.map((f) => f.path)).toEqual([
        "images/bg.png",
        "index.html",
        "style.css",
      ]);
      expect(bucket.has(`_templates/${templateId}/v1/index.html`)).toBe(true);
      expect(bucket.has(`_templates/${templateId}/v1/drafts/secret.html`)).toBe(
        false,
      );
      expect(template?.versions[0].sourcePath).toBe("retro/");

      const latest = await listLatestPosts("template", 6);
      expect(latest[0].id).toBe(postId);
      expect(latest.every((p) => p.kind === "template")).toBe(true);
    });

    test("a template shared from a wrapping folder is rooted inside it", async () => {
      expect(commonDirectory(["a/b/x.html", "a/b/c/y.css"])).toBe("a/b/");
      expect(commonDirectory(["a/x.html", "b/y.html"])).toBe("");
      expect(commonDirectory(["index.html", "a/y.html"])).toBe("");

      // Everything checked is in hello-world/.
      put("alice/hello-world/index.html");
      put("alice/index.html");
      const { postId } = await publish({ files: ["hello-world/index.html"] });
      const template = await getTemplateForPost(postId);
      expect(template?.files.map((f) => f.path)).toEqual(["index.html"]);
      expect(template?.versions[0].sourcePath).toBe("hello-world/");

      // Applying into a new folder named the same puts it one level deep.
      await applyTemplate(bob, template!.versions[0].id, {
        targetPath: "hello-world",
        backup: true,
        createCollections: true,
      });
      expect(bucket.has("bob/hello-world/index.html")).toBe(true);
      expect(bucket.has("bob/hello-world/hello-world/index.html")).toBe(false);
    });

    test("refuses unhostable, missing, backup and escaping paths", async () => {
      put("alice/bad/run.exe", "application/octet-stream");
      for (const files of [
        ["bad/run.exe"],
        [],
        ["../bob/index.html"],
        ["missing.html"],
        [".backup/2026/index.html"],
      ]) {
        await expect(publish({ files })).rejects.toMatchObject({ status: 400 });
      }
      await expect(publish({ cc0Accepted: false })).rejects.toMatchObject({
        status: 400,
      });
    });

    test("applies into a folder and backs up what it overwrites", async () => {
      put("alice/retro/index.html");
      put("alice/retro/guestbook.js", "application/javascript");
      await createCollections(alice, [
        { name: "guestbook", read_access: "world", write_access: "create" },
      ]);
      const { postId, templateId } = await publish({
        collections: ["guestbook"],
      });
      const template = await getTemplateForPost(postId);
      const versionId = template!.versions[0].id;

      put("bob/index.html", "text/html", 5);
      put("bob/about.html");

      const plan = await planApplication(bob, versionId, "/");
      expect(plan.targetPath).toBe("");
      expect(plan.files).toEqual([
        { path: "guestbook.js", sizeBytes: 10, action: "create" },
        { path: "index.html", sizeBytes: 10, action: "overwrite" },
      ]);
      expect(plan.collections).toEqual([
        { name: "guestbook", action: "create" },
      ]);

      const result = await applyTemplate(bob, versionId, {
        targetPath: "",
        backup: true,
        createCollections: true,
      });
      expect(result.overwritten).toBe(1);
      expect(result.createdCollections).toEqual(["guestbook"]);
      expect(bucket.get(`bob/${result.backupPath}index.html`)?.size).toBe(5);
      expect(bucket.get("bob/index.html")?.size).toBe(10);
      expect(bucket.has("bob/guestbook.js")).toBe(true);
      expect(bucket.has("bob/about.html")).toBe(true);

      const [collection] = await listCollections(bob, ["guestbook"]);
      expect({
        read_access: collection.read_access,
        write_access: collection.write_access,
      }).toEqual({
        read_access: "world",
        write_access: "create",
      });

      // Applying again counts the person once.
      await applyTemplate(bob, versionId, {
        targetPath: "retro-home",
        backup: true,
        createCollections: true,
      });
      expect(bucket.has("bob/retro-home/index.html")).toBe(true);
      expect((await getTemplateForPost(postId))?.applyCount).toBe(1);

      expect(templateId).toBeDefined();
    });

    test("without the database feature, files apply but collections don't", async () => {
      put("alice/retro/index.html");
      await createCollections(alice, [
        { name: "guestbook", read_access: "world", write_access: "create" },
      ]);
      const { postId } = await publish({ collections: ["guestbook"] });
      const versionId = (await getTemplateForPost(postId))!.versions[0].id;

      getUserFeatures.mockResolvedValue(new Set());
      try {
        const plan = await planApplication(carol, versionId, "unpaid");
        expect(plan.collections).toEqual([
          { name: "guestbook", action: "unavailable" },
        ]);
        const result = await applyTemplate(carol, versionId, {
          targetPath: "unpaid",
          backup: true,
          createCollections: true,
        });
        expect(bucket.has("carol/unpaid/index.html")).toBe(true);
        expect(result.createdCollections).toEqual([]);
        expect(result.skippedCollections).toEqual([]);
        expect(result.unavailableCollections).toEqual(["guestbook"]);
        expect(await listCollections(carol, ["guestbook"])).toEqual([]);
      } finally {
        getUserFeatures.mockResolvedValue(new Set(["database"]));
      }
    });

    test("without a backup, nothing is kept", async () => {
      put("alice/retro/index.html");
      const { postId } = await publish();
      const versionId = (await getTemplateForPost(postId))!.versions[0].id;
      put("carol/index.html", "text/html", 3);
      const result = await applyTemplate(carol, versionId, {
        targetPath: "",
        backup: false,
        createCollections: true,
      });
      expect(result.backupPath).toBeNull();
      expect(bucket.get("carol/index.html")?.size).toBe(10);
      expect(
        [...bucket.keys()].some((key) => key.startsWith("carol/.backup/")),
      ).toBe(false);
    });

    test("new versions snapshot again and keep the old files", async () => {
      put("alice/retro/index.html");
      const { postId, templateId } = await publish();
      put("alice/retro/new.css", "text/css");
      expect(
        await publishTemplateVersion(alice, templateId, {
          files: ["retro/index.html", "retro/new.css"],
          changelog: "CSS 추가",
          collections: [],
        }),
      ).toBe(2);
      await expect(
        publishTemplateVersion(bob, templateId, {
          files: ["retro/index.html"],
          changelog: null,
          collections: [],
        }),
      ).rejects.toMatchObject({ status: 403 });

      const template = await getTemplateForPost(postId);
      expect(template?.versions.map((v) => v.version)).toEqual([2, 1]);
      expect(template?.files.map((f) => f.path)).toEqual([
        "index.html",
        "new.css",
      ]);
      expect(bucket.has(`_templates/${templateId}/v1/index.html`)).toBe(true);
      expect(bucket.has(`_templates/${templateId}/v2/new.css`)).toBe(true);
    });

    test("deleted templates cannot be applied and lose their files", async () => {
      put("alice/retro/index.html");
      const { postId, templateId } = await publish();
      const versionId = (await getTemplateForPost(postId))!.versions[0].id;
      const deleted = await deletePost(alice, postId);
      expect(deleted.templateId).toBe(templateId);
      await deleteTemplateObjects(templateId);
      expect(
        [...bucket.keys()].some((key) =>
          key.startsWith(`_templates/${templateId}/`),
        ),
      ).toBe(false);
      await expect(planApplication(bob, versionId, "")).rejects.toMatchObject({
        status: 404,
      });
    });

    test("refuses to apply into the backup folder", async () => {
      put("alice/retro/index.html");
      const { postId } = await publish();
      const versionId = (await getTemplateForPost(postId))!.versions[0].id;
      await expect(
        planApplication(bob, versionId, ".backup/x"),
      ).rejects.toMatchObject({ status: 400 });
    });
  });
});
