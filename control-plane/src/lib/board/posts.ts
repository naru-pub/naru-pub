import { sql } from "kysely";
import { db } from "@/lib/database";
import type { User } from "@/lib/auth";
import { canModerate } from "./access";
import {
  MAX_POST_BODY_LENGTH,
  MAX_TITLE_LENGTH,
  POSTS_PER_HOUR,
  POSTS_PER_PAGE,
  type PostKind,
  type PostSort,
} from "./constants";
import { BoardError } from "./errors";
import { assertUnderHourlyLimit } from "./limits";

export interface PostSummary {
  id: string;
  kind: PostKind;
  title: string;
  excerpt: string;
  authorLoginName: string;
  authorSiteRenderedAt: Date | null;
  createdAt: Date;
  activityAt: Date;
  replyCount: number;
  likeCount: number;
  lastReplyAt: Date | null;
  lastReplyLoginName: string | null;
  solved: boolean;
  template: {
    id: string;
    applyCount: number;
    version: number | null;
    previewRenderedAt: Date | null;
  } | null;
}

const EXCERPT_LENGTH = 160;

function excerpt(body: string): string {
  const flat = body.replace(/\s+/g, " ").trim();
  return flat.length > EXCERPT_LENGTH
    ? `${flat.slice(0, EXCERPT_LENGTH)}…`
    : flat;
}

function summaryQuery() {
  return db
    .selectFrom("board_posts as p")
    .innerJoin("users as u", "u.id", "p.user_id")
    .leftJoin("users as lr", "lr.id", "p.last_reply_user_id")
    .leftJoin("board_templates as t", "t.post_id", "p.id")
    .leftJoin("board_template_versions as v", "v.id", "t.latest_version_id")
    .select([
      "p.id",
      "p.kind",
      "p.title",
      sql<string>`left(p.body, ${EXCERPT_LENGTH * 2})`.as("body"),
      "u.login_name as author_login_name",
      "u.site_rendered_at as author_site_rendered_at",
      "p.created_at",
      "p.activity_at",
      "p.reply_count",
      "p.like_count",
      "p.last_reply_at",
      "lr.login_name as last_reply_login_name",
      "p.solved_reply_id",
      "t.id as template_id",
      "t.apply_count",
      "v.version",
      "v.preview_rendered_at",
    ])
    .where("p.deleted_at", "is", null);
}

type SummaryRow = Awaited<
  ReturnType<ReturnType<typeof summaryQuery>["execute"]>
>[number];

function toSummary(row: SummaryRow): PostSummary {
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    excerpt: excerpt(row.body),
    authorLoginName: row.author_login_name,
    authorSiteRenderedAt: row.author_site_rendered_at,
    createdAt: row.created_at,
    activityAt: row.activity_at,
    replyCount: row.reply_count,
    likeCount: row.like_count,
    lastReplyAt: row.last_reply_at,
    lastReplyLoginName: row.last_reply_login_name,
    solved: row.solved_reply_id !== null,
    template: row.template_id
      ? {
          id: row.template_id,
          applyCount: row.apply_count ?? 0,
          version: row.version,
          previewRenderedAt: row.preview_rendered_at,
        }
      : null,
  };
}

export async function listPosts(options: {
  kind: PostKind | null;
  sort: PostSort;
  page: number;
}): Promise<{ posts: PostSummary[]; hasMore: boolean }> {
  let query = summaryQuery();
  if (options.kind) query = query.where("p.kind", "=", options.kind);

  if (options.sort === "applied" && options.kind === "template") {
    query = query.orderBy("t.apply_count", "desc").orderBy("p.id", "desc");
  } else if (options.sort === "new") {
    query = query.orderBy("p.created_at", "desc").orderBy("p.id", "desc");
  } else {
    query = query.orderBy("p.activity_at", "desc").orderBy("p.id", "desc");
  }

  const page = Math.max(1, Math.min(options.page, 1000));
  const rows = await query
    .limit(POSTS_PER_PAGE + 1)
    .offset((page - 1) * POSTS_PER_PAGE)
    .execute();
  return {
    posts: rows.slice(0, POSTS_PER_PAGE).map(toSummary),
    hasMore: rows.length > POSTS_PER_PAGE,
  };
}

// The front page's board card: the newest posts of one kind.
export async function listLatestPosts(
  kind: PostKind,
  limit: number,
): Promise<PostSummary[]> {
  const rows = await summaryQuery()
    .where("p.kind", "=", kind)
    .orderBy("p.created_at", "desc")
    .orderBy("p.id", "desc")
    .limit(limit)
    .execute();
  return rows.map(toSummary);
}

export async function listPopularTemplatePosts(
  limit: number,
): Promise<PostSummary[]> {
  const rows = await summaryQuery()
    .where("p.kind", "=", "template")
    .orderBy("t.apply_count", "desc")
    .orderBy("p.id", "desc")
    .limit(limit)
    .execute();
  return rows.map(toSummary);
}

export interface PostDetail {
  id: string;
  kind: PostKind;
  title: string;
  body: string;
  userId: string;
  authorLoginName: string;
  authorSiteRenderedAt: Date | null;
  createdAt: Date;
  editedAt: Date | null;
  replyCount: number;
  likeCount: number;
  likedByViewer: boolean;
  solvedReplyId: string | null;
}

export async function getPost(
  id: string,
  viewer: User | null,
): Promise<PostDetail | null> {
  const row = await db
    .selectFrom("board_posts as p")
    .innerJoin("users as u", "u.id", "p.user_id")
    .select([
      "p.id",
      "p.kind",
      "p.title",
      "p.body",
      "p.user_id",
      "u.login_name",
      "u.site_rendered_at",
      "p.created_at",
      "p.edited_at",
      "p.reply_count",
      "p.like_count",
      "p.solved_reply_id",
    ])
    .where("p.id", "=", id)
    .where("p.deleted_at", "is", null)
    .executeTakeFirst();
  if (!row) return null;

  const liked = viewer
    ? await db
        .selectFrom("board_post_likes")
        .select("post_id")
        .where("post_id", "=", id)
        .where("user_id", "=", viewer.id)
        .executeTakeFirst()
    : undefined;

  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    body: row.body,
    userId: row.user_id,
    authorLoginName: row.login_name,
    authorSiteRenderedAt: row.site_rendered_at,
    createdAt: row.created_at,
    editedAt: row.edited_at,
    replyCount: row.reply_count,
    likeCount: row.like_count,
    likedByViewer: !!liked,
    solvedReplyId: row.solved_reply_id,
  };
}

export function validateTitle(value: unknown): string {
  const title = typeof value === "string" ? value.trim() : "";
  if (!title) throw new BoardError(400, "제목을 입력해 주세요.");
  if (title.length > MAX_TITLE_LENGTH) {
    throw new BoardError(400, `제목은 ${MAX_TITLE_LENGTH}자까지 쓸 수 있어요.`);
  }
  return title;
}

export function validatePostBody(value: unknown): string {
  const body = typeof value === "string" ? value.trim() : "";
  if (body.length > MAX_POST_BODY_LENGTH) {
    throw new BoardError(
      400,
      `본문은 ${MAX_POST_BODY_LENGTH.toLocaleString("ko-KR")}자까지 쓸 수 있어요.`,
    );
  }
  return body;
}

export async function assertCanPost(userId: string): Promise<void> {
  await assertUnderHourlyLimit("board_posts", userId, POSTS_PER_HOUR);
}

// Every kind but templates, which publish files too (templates.ts).
export async function createPost(
  user: User,
  input: { kind: Exclude<PostKind, "template">; title: unknown; body: unknown },
): Promise<string> {
  const title = validateTitle(input.title);
  const body = validatePostBody(input.body);
  if (input.kind !== "site" && !body) {
    throw new BoardError(400, "본문을 입력해 주세요.");
  }
  await assertCanPost(user.id);

  const row = await db
    .insertInto("board_posts")
    .values({ user_id: user.id, kind: input.kind, title, body })
    .returning("id")
    .executeTakeFirstOrThrow();
  return row.id;
}

async function findLivePost(id: string) {
  const post = await db
    .selectFrom("board_posts")
    .select(["id", "user_id", "kind", "federated_note_iri"])
    .where("id", "=", id)
    .where("deleted_at", "is", null)
    .executeTakeFirst();
  if (!post) throw new BoardError(404, "글을 찾을 수 없습니다.");
  return post;
}

// Only the author edits a post; admins moderate by deleting.
export async function editPost(
  user: User,
  id: string,
  input: { title: unknown; body: unknown },
): Promise<void> {
  const post = await findLivePost(id);
  if (post.user_id !== user.id) {
    throw new BoardError(403, "내 글만 고칠 수 있어요.");
  }
  const title = validateTitle(input.title);
  const body = validatePostBody(input.body);
  if (post.kind !== "site" && post.kind !== "template" && !body) {
    throw new BoardError(400, "본문을 입력해 주세요.");
  }
  await db
    .updateTable("board_posts")
    .set({ title, body, edited_at: new Date() })
    .where("id", "=", id)
    .execute();
}

// Soft delete, so replies and applications that point at the post survive.
// Returns what the caller must clean up outside the database.
export async function deletePost(
  user: User,
  id: string,
): Promise<{
  kind: PostKind;
  authorId: string;
  templateId: string | null;
  federatedNoteIri: string | null;
}> {
  const post = await findLivePost(id);
  if (!canModerate(user, post.user_id)) {
    throw new BoardError(403, "이 글을 지울 수 없어요.");
  }
  await db
    .updateTable("board_posts")
    .set({ deleted_at: new Date() })
    .where("id", "=", id)
    .execute();
  const template = await db
    .selectFrom("board_templates")
    .select("id")
    .where("post_id", "=", id)
    .executeTakeFirst();
  return {
    kind: post.kind,
    authorId: post.user_id,
    templateId: template?.id ?? null,
    federatedNoteIri: post.federated_note_iri,
  };
}

export async function setPostLike(
  user: User,
  id: string,
  liked: boolean,
): Promise<number> {
  await findLivePost(id);
  return await db.transaction().execute(async (tx) => {
    const changed = liked
      ? await tx
          .insertInto("board_post_likes")
          .values({ post_id: id, user_id: user.id })
          .onConflict((oc) => oc.columns(["post_id", "user_id"]).doNothing())
          .executeTakeFirst()
      : await tx
          .deleteFrom("board_post_likes")
          .where("post_id", "=", id)
          .where("user_id", "=", user.id)
          .executeTakeFirst();
    const count =
      "numInsertedOrUpdatedRows" in changed
        ? Number(changed.numInsertedOrUpdatedRows ?? 0)
        : Number(changed.numDeletedRows);
    const row = await tx
      .updateTable("board_posts")
      .set({
        like_count: sql`like_count + ${liked ? count : -count}`,
      })
      .where("id", "=", id)
      .returning("like_count")
      .executeTakeFirstOrThrow();
    return row.like_count;
  });
}

// A question's author marks the reply that answered it, or clears the mark
// with null.
export async function setSolvedReply(
  user: User,
  postId: string,
  replyId: string | null,
): Promise<void> {
  const post = await findLivePost(postId);
  if (post.kind !== "question") {
    throw new BoardError(400, "질문 글에만 해결 표시를 할 수 있어요.");
  }
  if (post.user_id !== user.id) {
    throw new BoardError(403, "질문한 사람만 해결 표시를 할 수 있어요.");
  }
  if (replyId) {
    const reply = await db
      .selectFrom("board_replies")
      .select("id")
      .where("id", "=", replyId)
      .where("post_id", "=", postId)
      .where("deleted_at", "is", null)
      .executeTakeFirst();
    if (!reply) throw new BoardError(404, "답글을 찾을 수 없습니다.");
  }
  await db
    .updateTable("board_posts")
    .set({ solved_reply_id: replyId })
    .where("id", "=", postId)
    .execute();
}
