import Link from "next/link";
import { notFound } from "next/navigation";
import { validateRequest } from "@/lib/auth";
import { isBoardAdmin } from "@/lib/board/access";
import { getPost } from "@/lib/board/posts";
import { listReplies } from "@/lib/board/replies";
import {
  ReplyThread,
  type ThreadReply,
} from "../../../_components/ReplyThread";
import { formatRelative } from "../../../_components/format";
import { PostTitle } from "../../../_components/PostTitle";

// Post and reply ids are both UUIDs.
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// One reply and everything under it: the permalink, and where a thread too
// long or too deep for its page continues.
export default async function ReplyPage({
  params,
}: {
  params: Promise<{ postId: string; replyId: string }>;
}) {
  const { postId, replyId } = await params;
  if (!ID.test(postId) || !ID.test(replyId)) notFound();

  const { user } = await validateRequest();
  const post = await getPost(postId, user);
  if (!post) notFound();
  const { replies } = await listReplies(post.id, user, replyId);
  if (replies.length === 0) notFound();

  const threadReplies: ThreadReply[] = replies.map((reply) => ({
    id: reply.id,
    parentId: reply.id === replyId ? null : reply.parentId,
    depth: reply.depth,
    body: reply.body,
    userId: reply.userId,
    authorLoginName: reply.authorLoginName,
    time: formatRelative(reply.createdAt),
    edited: reply.editedAt !== null,
    likeCount: reply.likeCount,
    likedByViewer: reply.likedByViewer,
    appliedVersion: null,
  }));
  const parentId = replies[0].parentId;

  return (
    <div className="bg-background min-h-screen p-4 sm:p-6">
      <main className="mx-auto max-w-4xl space-y-6">
        <nav
          aria-label="위치"
          className="flex flex-wrap gap-2 text-xs text-muted-foreground"
        >
          <Link href="/board" className="text-primary hover:underline">
            게시판
          </Link>
          <span>/</span>
          <Link
            href={`/board/${post.id}`}
            className="text-primary hover:underline"
          >
            <PostTitle title={post.title} />
          </Link>
        </nav>
        <div className="flex flex-wrap gap-4 text-sm">
          <Link
            href={`/board/${post.id}#reply-${replyId}`}
            className="text-primary hover:underline"
          >
            ← 스레드 전체 보기
          </Link>
          {parentId && (
            <Link
              href={`/board/${post.id}/replies/${parentId}`}
              className="text-primary hover:underline"
            >
              ↑ 윗 답글 보기
            </Link>
          )}
        </div>
        <ReplyThread
          postId={post.id}
          postAuthorId={post.userId}
          replies={threadReplies}
          viewer={
            user
              ? {
                  id: user.id,
                  isAdmin: isBoardAdmin(user),
                  canWrite: !!user.emailVerifiedAt,
                }
              : null
          }
          isQuestion={post.kind === "question"}
          solvedReplyId={post.solvedReplyId}
          depthOffset={replies[0].depth}
        />
      </main>
    </div>
  );
}
