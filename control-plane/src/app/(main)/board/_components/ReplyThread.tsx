"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { MAX_REPLY_BODY_LENGTH } from "@/lib/board/constants";
import { boardRequest } from "./api";
import { LikeButton } from "./LikeButton";
import { ReplyComposer } from "./ReplyComposer";

export interface ThreadReply {
  id: string;
  parentId: string | null;
  depth: number;
  body: string | null;
  userId: string;
  authorLoginName: string;
  time: string;
  edited: boolean;
  likeCount: number;
  likedByViewer: boolean;
  // The template version this author applied, on a template post.
  appliedVersion: number | null;
}

export interface ThreadViewer {
  id: string;
  isAdmin: boolean;
  canWrite: boolean;
}

// Replies arrive flat in display order. Each is indented by depth, and a
// collapsed reply hides everything under it.
export function ReplyThread({
  postId,
  postAuthorId,
  replies,
  viewer,
  isQuestion,
  solvedReplyId,
  depthOffset = 0,
}: {
  postId: string;
  postAuthorId: string;
  replies: ThreadReply[];
  viewer: ThreadViewer | null;
  isQuestion: boolean;
  solvedReplyId: string | null;
  depthOffset?: number;
}) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [replyingTo, setReplyingTo] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);

  const byId = useMemo(
    () => new Map(replies.map((reply) => [reply.id, reply])),
    [replies],
  );
  const childCount = useMemo(() => {
    const counts = new Map<string, number>();
    for (const reply of replies) {
      let parent = reply.parentId;
      while (parent && byId.has(parent)) {
        counts.set(parent, (counts.get(parent) ?? 0) + 1);
        parent = byId.get(parent)!.parentId;
      }
    }
    return counts;
  }, [replies, byId]);

  function isHidden(reply: ThreadReply) {
    let parent = reply.parentId;
    while (parent) {
      if (collapsed.has(parent)) return true;
      parent = byId.get(parent)?.parentId ?? null;
    }
    return false;
  }

  function toggle(id: string) {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  if (replies.length === 0) {
    return (
      <p className="py-6 text-center text-sm text-muted-foreground">
        아직 답글이 없어요.
      </p>
    );
  }

  return (
    <ol className="flex flex-col">
      {replies.map((reply) => {
        if (isHidden(reply)) return null;
        const depth = Math.max(0, reply.depth - depthOffset);
        const isCollapsed = collapsed.has(reply.id);
        const descendants = childCount.get(reply.id) ?? 0;
        return (
          <li
            key={reply.id}
            id={`reply-${reply.id}`}
            className="scroll-mt-24"
            style={{
              marginLeft: depth === 0 ? 0 : `min(${depth * 1.5}rem, 30vw)`,
            }}
          >
            <div
              className={
                depth === 0 ? "" : "border-l border-border pl-3 sm:pl-4"
              }
            >
              <ReplyItemView
                postId={postId}
                reply={reply}
                viewer={viewer}
                isPostAuthor={reply.userId === postAuthorId}
                isQuestion={isQuestion}
                viewerIsQuestionAuthor={!!viewer && viewer.id === postAuthorId}
                solved={solvedReplyId === reply.id}
                collapsed={isCollapsed}
                descendants={descendants}
                onToggle={() => toggle(reply.id)}
                onReply={() => {
                  setEditing(null);
                  setReplyingTo(replyingTo === reply.id ? null : reply.id);
                }}
                editing={editing === reply.id}
                onEdit={() => {
                  setReplyingTo(null);
                  setEditing(editing === reply.id ? null : reply.id);
                }}
                onEditDone={() => setEditing(null)}
              />
              {replyingTo === reply.id && (
                <div className="mb-4 ml-0 sm:ml-11">
                  <ReplyComposer
                    postId={postId}
                    parentId={reply.id}
                    label={`↳ ${reply.authorLoginName} 님에게 답글`}
                    autoFocus
                    onDone={() => setReplyingTo(null)}
                  />
                </div>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

function Avatar({ name }: { name: string }) {
  // A steady color per name, so people are easy to follow down a thread.
  let hash = 0;
  for (const char of name) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  const hue = hash % 360;
  return (
    <span
      aria-hidden="true"
      className="flex h-8 w-8 shrink-0 items-center justify-center text-sm font-bold text-neutral-900"
      style={{ backgroundColor: `hsl(${hue} 70% 75%)` }}
    >
      {name.charAt(0)}
    </span>
  );
}

function ReplyItemView({
  postId,
  reply,
  viewer,
  isPostAuthor,
  isQuestion,
  viewerIsQuestionAuthor,
  solved,
  collapsed,
  descendants,
  onToggle,
  onReply,
  editing,
  onEdit,
  onEditDone,
}: {
  postId: string;
  reply: ThreadReply;
  viewer: ThreadViewer | null;
  isPostAuthor: boolean;
  isQuestion: boolean;
  viewerIsQuestionAuthor: boolean;
  solved: boolean;
  collapsed: boolean;
  descendants: number;
  onToggle: () => void;
  onReply: () => void;
  editing: boolean;
  onEdit: () => void;
  onEditDone: () => void;
}) {
  const router = useRouter();
  const [draft, setDraft] = useState(reply.body ?? "");
  const [busy, setBusy] = useState(false);
  const own = !!viewer && viewer.id === reply.userId;
  const canDelete = own || !!viewer?.isAdmin;

  async function run(action: () => Promise<unknown>, success?: string) {
    setBusy(true);
    try {
      await action();
      if (success) toast.success(success);
      router.refresh();
    } catch (error: any) {
      toast.error(error.message);
    } finally {
      setBusy(false);
    }
  }

  if (reply.body === null) {
    return (
      <div className="flex items-center gap-3 py-3 text-sm text-muted-foreground">
        <span>[삭제된 답글]</span>
        <button
          type="button"
          onClick={onToggle}
          className="text-xs hover:text-foreground"
          aria-expanded={!collapsed}
        >
          {collapsed ? `[+${descendants}]` : "[−]"}
        </button>
      </div>
    );
  }

  return (
    <div className="flex gap-3 py-3">
      <Avatar name={reply.authorLoginName} />
      <div className="min-w-0 flex-1 space-y-1.5">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
          <span className="font-bold text-foreground">
            {reply.authorLoginName}
          </span>
          {isPostAuthor && (
            <span className="border border-link px-1.5 text-[11px] text-link">
              작성자
            </span>
          )}
          {reply.appliedVersion !== null && (
            <span className="border border-primary px-1.5 text-[11px] text-primary">
              v{reply.appliedVersion} 적용함
            </span>
          )}
          {solved && (
            <span className="bg-success/10 px-1.5 text-[11px] text-success">
              해결한 답글
            </span>
          )}
          <Link
            href={`/board/${postId}/replies/${reply.id}`}
            className="hover:underline"
          >
            {reply.time}
          </Link>
          {reply.edited && <span>(고침)</span>}
          <button
            type="button"
            onClick={onToggle}
            className="hover:text-foreground"
            aria-expanded={!collapsed}
            aria-label={collapsed ? "펼치기" : "접기"}
          >
            {collapsed ? `[+${descendants}]` : "[−]"}
          </button>
        </div>

        {collapsed ? null : editing ? (
          <div className="space-y-2">
            <label htmlFor={`edit-${reply.id}`} className="sr-only">
              답글 고치기
            </label>
            <textarea
              id={`edit-${reply.id}`}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              maxLength={MAX_REPLY_BODY_LENGTH}
              rows={3}
              className="w-full resize-y border border-border bg-background px-3 py-2 text-sm"
            />
            <div className="flex gap-2">
              <button
                type="button"
                disabled={busy || !draft.trim()}
                onClick={() =>
                  run(async () => {
                    await boardRequest(
                      `/api/board/replies/${reply.id}`,
                      "PATCH",
                      {
                        body: draft,
                      },
                    );
                    onEditDone();
                  })
                }
                className="h-9 bg-primary px-3 text-sm font-bold text-primary-foreground disabled:opacity-50"
              >
                저장
              </button>
              <button
                type="button"
                onClick={onEditDone}
                className="h-9 border border-border px-3 text-sm"
              >
                취소
              </button>
            </div>
          </div>
        ) : (
          <>
            <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-foreground/90">
              {reply.body}
            </p>
            <div className="flex flex-wrap items-center gap-4 text-xs">
              {viewer?.canWrite && (
                <button
                  type="button"
                  onClick={onReply}
                  className="text-muted-foreground hover:text-foreground"
                >
                  답글
                </button>
              )}
              <LikeButton
                url={`/api/board/replies/${reply.id}/like`}
                initialLiked={reply.likedByViewer}
                initialCount={reply.likeCount}
                signedIn={!!viewer}
                compact
              />
              {own && viewer?.canWrite && (
                <button
                  type="button"
                  onClick={onEdit}
                  className="text-muted-foreground hover:text-foreground"
                >
                  고치기
                </button>
              )}
              {canDelete && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    if (!window.confirm("이 답글을 지울까요?")) return;
                    run(
                      () =>
                        boardRequest(
                          `/api/board/replies/${reply.id}`,
                          "DELETE",
                        ),
                      "답글을 지웠어요.",
                    );
                  }}
                  className="text-muted-foreground hover:text-destructive"
                >
                  지우기
                </button>
              )}
              {isQuestion && viewerIsQuestionAuthor && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    run(() =>
                      boardRequest(`/api/board/posts/${postId}/solve`, "POST", {
                        replyId: solved ? null : reply.id,
                      }),
                    )
                  }
                  className="text-muted-foreground hover:text-foreground"
                >
                  {solved ? "해결 표시 취소" : "이 답글로 해결"}
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
