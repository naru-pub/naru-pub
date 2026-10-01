import { sql } from "kysely";
import { db } from "@/lib/database";
import type { User } from "@/lib/auth";
import { canModerate } from "./access";
import {
  MAX_REPLY_BODY_LENGTH,
  MAX_REPLY_DEPTH,
  MAX_THREAD_REPLIES,
  REPLIES_PER_HOUR,
} from "./constants";
import { BoardError } from "./errors";
import { assertUnderHourlyLimit } from "./limits";

export interface ReplyItem {
  id: string;
  parentId: string | null;
  depth: number;
  // null once deleted; a deleted reply is kept only while it has live replies
  // under it, so the thread around it still reads.
  body: string | null;
  userId: string;
  authorLoginName: string;
  createdAt: Date;
  editedAt: Date | null;
  likeCount: number;
  likedByViewer: boolean;
}

// A post's replies in display order: `path` puts each reply straight after
// its parent, and siblings oldest first. With rootReplyId, only that reply and
// the replies under it.
export async function listReplies(
  postId: string,
  viewer: User | null,
  rootReplyId?: string,
): Promise<{ replies: ReplyItem[]; truncated: boolean }> {
  let query = db
    .selectFrom("board_replies as r")
    .innerJoin("users as u", "u.id", "r.user_id")
    .select([
      "r.id",
      "r.parent_id",
      "r.depth",
      "r.path",
      "r.body",
      "r.user_id",
      "u.login_name",
      "r.created_at",
      "r.edited_at",
      "r.like_count",
      "r.deleted_at",
    ])
    .where("r.post_id", "=", postId)
    .orderBy("r.path");
  if (rootReplyId) {
    query = query.where(sql<boolean>`r.path @> array[${rootReplyId}::uuid]`);
  }
  const rows = await query.limit(MAX_THREAD_REPLIES + 1).execute();
  const truncated = rows.length > MAX_THREAD_REPLIES;
  const visible = rows.slice(0, MAX_THREAD_REPLIES);

  // Ids of every reply with a live reply somewhere under it.
  const hasLiveDescendant = new Set<string>();
  for (const row of visible) {
    if (row.deleted_at) continue;
    for (const ancestor of row.path.slice(0, -1)) {
      hasLiveDescendant.add(String(ancestor));
    }
  }

  const liked = new Set<string>();
  if (viewer && visible.length > 0) {
    const likes = await db
      .selectFrom("board_reply_likes")
      .select("reply_id")
      .where("user_id", "=", viewer.id)
      .where(
        "reply_id",
        "in",
        visible.map((row) => row.id),
      )
      .execute();
    for (const like of likes) liked.add(like.reply_id);
  }

  const replies = visible
    .filter((row) => !row.deleted_at || hasLiveDescendant.has(row.id))
    .map((row) => ({
      id: row.id,
      parentId: row.parent_id,
      depth: row.depth,
      body: row.deleted_at ? null : row.body,
      userId: row.user_id,
      authorLoginName: row.login_name,
      createdAt: row.created_at,
      editedAt: row.edited_at,
      likeCount: row.like_count,
      likedByViewer: liked.has(row.id),
    }));
  return { replies, truncated };
}

export function validateReplyBody(value: unknown): string {
  const body = typeof value === "string" ? value.trim() : "";
  if (!body) throw new BoardError(400, "답글을 입력해 주세요.");
  if (body.length > MAX_REPLY_BODY_LENGTH) {
    throw new BoardError(
      400,
      `답글은 ${MAX_REPLY_BODY_LENGTH.toLocaleString("ko-KR")}자까지 쓸 수 있어요.`,
    );
  }
  return body;
}

export async function createReply(
  user: User,
  postId: string,
  input: { parentId: string | null; body: unknown },
): Promise<string> {
  const body = validateReplyBody(input.body);
  await assertUnderHourlyLimit("board_replies", user.id, REPLIES_PER_HOUR);

  return await db.transaction().execute(async (tx) => {
    const post = await tx
      .selectFrom("board_posts")
      .select(["id", "user_id"])
      .where("id", "=", postId)
      .where("deleted_at", "is", null)
      .executeTakeFirst();
    if (!post) throw new BoardError(404, "글을 찾을 수 없습니다.");

    let parent: {
      id: string;
      user_id: string;
      depth: number;
      path: string[];
      parent_id: string | null;
    } | null = null;
    if (input.parentId) {
      const found = await tx
        .selectFrom("board_replies")
        .select(["id", "user_id", "depth", "path", "parent_id"])
        .where("id", "=", input.parentId)
        .where("post_id", "=", postId)
        .where("deleted_at", "is", null)
        .executeTakeFirst();
      if (!found) throw new BoardError(404, "답글을 찾을 수 없습니다.");
      parent = found;
    }

    // Past the deepest level a reply joins its parent's siblings, still
    // notifying the person it answered.
    const answered = parent;
    let attachTo = parent;
    if (parent && parent.depth >= MAX_REPLY_DEPTH) {
      attachTo = parent.parent_id
        ? await tx
            .selectFrom("board_replies")
            .select(["id", "user_id", "depth", "path", "parent_id"])
            .where("id", "=", parent.parent_id)
            .executeTakeFirstOrThrow()
        : null;
    }

    // The id is needed before the insert: it ends the reply's own path.
    const { id } = await sql<{ id: string }>`select uuid_v7()::text as id`
      .execute(tx)
      .then((result) => result.rows[0]);
    const depth = attachTo ? attachTo.depth + 1 : 0;
    const path = [...(attachTo?.path ?? []).map(String), id];

    await sql`
      insert into board_replies (id, post_id, parent_id, user_id, depth, path, body)
      values (${id}, ${postId}, ${attachTo?.id ?? null}, ${user.id}, ${depth},
              ${path}::uuid[], ${body})
    `.execute(tx);

    await tx
      .updateTable("board_posts")
      .set({
        reply_count: sql`reply_count + 1`,
        last_reply_at: sql`now()`,
        last_reply_user_id: user.id,
        activity_at: sql`now()`,
      })
      .where("id", "=", postId)
      .execute();

    const notify = new Map<string, "reply_to_post" | "reply_to_reply">();
    if (answered && answered.user_id !== user.id) {
      notify.set(answered.user_id, "reply_to_reply");
    }
    if (post.user_id !== user.id && !notify.has(post.user_id)) {
      notify.set(post.user_id, "reply_to_post");
    }
    if (notify.size > 0) {
      await tx
        .insertInto("board_notifications")
        .values(
          [...notify].map(([userId, reason]) => ({
            user_id: userId,
            reply_id: id,
            reason,
          })),
        )
        .execute();
    }

    return id;
  });
}

async function findLiveReply(id: string) {
  const reply = await db
    .selectFrom("board_replies as r")
    .innerJoin("board_posts as p", "p.id", "r.post_id")
    .select(["r.id", "r.user_id", "r.post_id"])
    .where("r.id", "=", id)
    .where("r.deleted_at", "is", null)
    .where("p.deleted_at", "is", null)
    .executeTakeFirst();
  if (!reply) throw new BoardError(404, "답글을 찾을 수 없습니다.");
  return reply;
}

export async function editReply(
  user: User,
  id: string,
  bodyInput: unknown,
): Promise<void> {
  const reply = await findLiveReply(id);
  if (reply.user_id !== user.id) {
    throw new BoardError(403, "내 답글만 고칠 수 있어요.");
  }
  const body = validateReplyBody(bodyInput);
  await db
    .updateTable("board_replies")
    .set({ body, edited_at: new Date() })
    .where("id", "=", id)
    .execute();
}

export async function deleteReply(user: User, id: string): Promise<string> {
  const reply = await findLiveReply(id);
  if (!canModerate(user, reply.user_id)) {
    throw new BoardError(403, "이 답글을 지울 수 없어요.");
  }
  await db.transaction().execute(async (tx) => {
    const deleted = await tx
      .updateTable("board_replies")
      .set({ deleted_at: new Date() })
      .where("id", "=", id)
      .where("deleted_at", "is", null)
      .executeTakeFirst();
    if (Number(deleted.numUpdatedRows) === 0) return;
    await tx
      .updateTable("board_posts")
      .set({
        reply_count: sql`greatest(reply_count - 1, 0)`,
        solved_reply_id: sql`case when solved_reply_id = ${id}::uuid then null else solved_reply_id end`,
      })
      .where("id", "=", reply.post_id)
      .execute();
    await tx
      .deleteFrom("board_notifications")
      .where("reply_id", "=", id)
      .execute();
  });
  return reply.post_id;
}

export async function setReplyLike(
  user: User,
  id: string,
  liked: boolean,
): Promise<number> {
  await findLiveReply(id);
  return await db.transaction().execute(async (tx) => {
    const changed = liked
      ? Number(
          (
            await tx
              .insertInto("board_reply_likes")
              .values({ reply_id: id, user_id: user.id })
              .onConflict((oc) =>
                oc.columns(["reply_id", "user_id"]).doNothing(),
              )
              .executeTakeFirst()
          ).numInsertedOrUpdatedRows ?? 0,
        )
      : Number(
          (
            await tx
              .deleteFrom("board_reply_likes")
              .where("reply_id", "=", id)
              .where("user_id", "=", user.id)
              .executeTakeFirst()
          ).numDeletedRows,
        );
    const row = await tx
      .updateTable("board_replies")
      .set({ like_count: sql`like_count + ${liked ? changed : -changed}` })
      .where("id", "=", id)
      .returning("like_count")
      .executeTakeFirstOrThrow();
    return row.like_count;
  });
}

export interface NotificationItem {
  id: string;
  reason: "reply_to_post" | "reply_to_reply";
  read: boolean;
  createdAt: Date;
  replyId: string;
  replyExcerpt: string;
  fromLoginName: string;
  postId: string;
  postTitle: string;
}

export async function listNotifications(
  userId: string,
  limit = 50,
): Promise<NotificationItem[]> {
  const rows = await db
    .selectFrom("board_notifications as n")
    .innerJoin("board_replies as r", "r.id", "n.reply_id")
    .innerJoin("board_posts as p", "p.id", "r.post_id")
    .innerJoin("users as u", "u.id", "r.user_id")
    .select([
      "n.id",
      "n.reason",
      "n.read_at",
      "n.created_at",
      "r.id as reply_id",
      sql<string>`left(r.body, 200)`.as("body"),
      "u.login_name",
      "p.id as post_id",
      "p.title",
    ])
    .where("n.user_id", "=", userId)
    .where("p.deleted_at", "is", null)
    .orderBy("n.created_at", "desc")
    .orderBy("n.id", "desc")
    .limit(limit)
    .execute();
  return rows.map((row) => ({
    id: row.id,
    reason: row.reason,
    read: row.read_at !== null,
    createdAt: row.created_at,
    replyId: row.reply_id,
    replyExcerpt: row.body.replace(/\s+/g, " ").trim(),
    fromLoginName: row.login_name,
    postId: row.post_id,
    postTitle: row.title,
  }));
}

export async function countUnreadNotifications(userId: string): Promise<{
  count: number;
  from: string[];
}> {
  const rows = await db
    .selectFrom("board_notifications as n")
    .innerJoin("board_replies as r", "r.id", "n.reply_id")
    .innerJoin("board_posts as p", "p.id", "r.post_id")
    .innerJoin("users as u", "u.id", "r.user_id")
    .select(["u.login_name"])
    .where("n.user_id", "=", userId)
    .where("n.read_at", "is", null)
    .where("p.deleted_at", "is", null)
    .orderBy("n.created_at", "desc")
    .limit(100)
    .execute();
  return {
    count: rows.length,
    from: [...new Set(rows.map((row) => row.login_name))].slice(0, 3),
  };
}

export async function markNotificationsRead(
  userId: string,
  ids: string[] | null,
): Promise<void> {
  let query = db
    .updateTable("board_notifications")
    .set({ read_at: new Date() })
    .where("user_id", "=", userId)
    .where("read_at", "is", null);
  if (ids) {
    if (ids.length === 0) return;
    query = query.where("id", "in", ids);
  }
  await query.execute();
}

// Opening a thread reads every notification about replies in it.
export async function markPostNotificationsRead(
  userId: string,
  postId: string,
): Promise<void> {
  await db
    .updateTable("board_notifications")
    .set({ read_at: new Date() })
    .where("user_id", "=", userId)
    .where("read_at", "is", null)
    .where("reply_id", "in", (eb) =>
      eb.selectFrom("board_replies").select("id").where("post_id", "=", postId),
    )
    .execute();
}
