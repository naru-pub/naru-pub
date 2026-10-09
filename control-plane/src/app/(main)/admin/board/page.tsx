import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { validateRequest } from "@/lib/auth";
import { isBoardAdmin } from "@/lib/board/access";
import { POST_KIND_LABELS } from "@/lib/board/constants";
import {
  listPostsForModeration,
  listRepliesForModeration,
  type ModerationStatus,
} from "@/lib/board/moderation";
import { LOGIN_NAME_REGEX } from "@/lib/const";
import { formatRelative } from "../../board/_components/format";
import { ModerationButton } from "./ModerationButton";

export const metadata: Metadata = { title: "게시판 관리 · 나루" };

const STATUS_LABELS: Record<ModerationStatus, string> = {
  live: "게시 중",
  deleted: "삭제됨",
  all: "전체",
};

type View = "posts" | "replies";

export default async function BoardModerationPage({
  searchParams,
}: {
  searchParams: Promise<{
    view?: string;
    status?: string;
    author?: string;
    page?: string;
  }>;
}) {
  const { user } = await validateRequest();
  if (!user || !isBoardAdmin(user)) redirect("/account");

  const params = await searchParams;
  const view: View = params.view === "replies" ? "replies" : "posts";
  const status: ModerationStatus =
    params.status === "deleted" || params.status === "all"
      ? params.status
      : "live";
  const authorInput = params.author?.trim().toLowerCase() ?? "";
  const author = LOGIN_NAME_REGEX.test(authorInput) ? authorInput : null;
  const page = Math.max(1, Math.min(1000, Number(params.page) || 1));

  const href = (
    changes: Partial<{
      view: View;
      status: ModerationStatus;
      page: number;
      author: string | null;
    }>,
  ) => {
    const next = new URLSearchParams();
    const nextView = changes.view ?? view;
    const nextStatus = changes.status ?? status;
    const nextAuthor = changes.author === undefined ? author : changes.author;
    if (nextView !== "posts") next.set("view", nextView);
    if (nextStatus !== "live") next.set("status", nextStatus);
    if (nextAuthor) next.set("author", nextAuthor);
    if ((changes.page ?? 1) > 1) next.set("page", String(changes.page));
    const query = next.toString();
    return query ? `/admin/board?${query}` : "/admin/board";
  };

  const posts =
    view === "posts"
      ? await listPostsForModeration({ status, author, page })
      : null;
  const replies =
    view === "replies"
      ? await listRepliesForModeration({ status, author, page })
      : null;
  const hasMore = posts?.hasMore ?? replies?.hasMore ?? false;

  const tab = (active: boolean) =>
    active
      ? "-mb-0.5 border-b-2 border-primary px-3 py-3 font-bold text-foreground"
      : "px-3 py-3 text-muted-foreground hover:text-foreground";

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-bold">게시판 관리</h2>
        <p className="text-sm text-muted-foreground">
          모든 글과 답글을 최근 순으로 봐요. 지운 글과 답글은 되살릴 수 있지만,
          템플릿 글은 지울 때 파일도 지워져서 되살릴 수 없어요.
        </p>
      </div>

      <section className="border-2 border-line bg-card">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b-2 border-line bg-secondary px-2">
          <nav aria-label="종류" className="flex text-sm">
            <Link
              href={href({ view: "posts" })}
              aria-current={view === "posts" ? "page" : undefined}
              className={tab(view === "posts")}
            >
              글
            </Link>
            <Link
              href={href({ view: "replies" })}
              aria-current={view === "replies" ? "page" : undefined}
              className={tab(view === "replies")}
            >
              답글
            </Link>
          </nav>
          <div className="flex flex-wrap items-center gap-3 px-2 py-2 text-xs">
            <nav aria-label="상태" className="flex gap-3">
              {(["live", "deleted", "all"] as const).map((value) => (
                <Link
                  key={value}
                  href={href({ status: value })}
                  aria-current={value === status ? "true" : undefined}
                  className={
                    value === status
                      ? "font-bold text-foreground"
                      : "text-muted-foreground hover:text-foreground"
                  }
                >
                  {STATUS_LABELS[value]}
                </Link>
              ))}
            </nav>
            <form action="/admin/board" className="flex items-center gap-1">
              {view !== "posts" && (
                <input type="hidden" name="view" value={view} />
              )}
              {status !== "live" && (
                <input type="hidden" name="status" value={status} />
              )}
              <label htmlFor="moderation-author" className="sr-only">
                작성자
              </label>
              <input
                id="moderation-author"
                name="author"
                defaultValue={author ?? ""}
                placeholder="작성자 아이디"
                className="h-9 w-36 border border-border bg-background px-2 text-xs"
              />
              <button
                type="submit"
                className="h-9 border border-border px-3 hover:bg-accent"
              >
                찾기
              </button>
              {author && (
                <Link
                  href={href({ author: null })}
                  className="text-muted-foreground hover:text-foreground"
                >
                  지우기
                </Link>
              )}
            </form>
          </div>
        </div>

        {posts &&
          (posts.posts.length === 0 ? (
            <p className="p-8 text-center text-sm text-muted-foreground">
              해당하는 글이 없어요.
            </p>
          ) : (
            <ul>
              {posts.posts.map((post) => (
                <li
                  key={post.id}
                  className={`flex flex-wrap items-start justify-between gap-3 border-b border-border p-4 last:border-b-0 ${post.deletedAt ? "bg-destructive/5" : ""}`}
                >
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                      <span className="border border-border px-1.5">
                        {POST_KIND_LABELS[post.kind]}
                      </span>
                      {post.deletedAt && (
                        <span className="text-destructive">
                          삭제됨 · {formatRelative(post.deletedAt)}
                        </span>
                      )}
                    </div>
                    {post.deletedAt ? (
                      <p className="break-words font-bold text-muted-foreground">
                        {post.title}
                      </p>
                    ) : (
                      <Link
                        href={`/board/${post.id}`}
                        className="break-words font-bold hover:text-primary"
                      >
                        {post.title}
                      </Link>
                    )}
                    {post.excerpt && (
                      <p className="line-clamp-2 text-sm text-muted-foreground">
                        {post.excerpt}
                      </p>
                    )}
                    <p className="text-xs text-muted-foreground">
                      <Link
                        href={href({ author: post.authorLoginName })}
                        className="text-foreground hover:underline"
                      >
                        {post.authorLoginName}
                      </Link>{" "}
                      · {formatRelative(post.createdAt)} · 답글{" "}
                      {post.replyCount}
                    </p>
                  </div>
                  {post.deletedAt ? (
                    post.restorable ? (
                      <ModerationButton
                        target="post"
                        id={post.id}
                        action="restore"
                      />
                    ) : (
                      <span className="text-xs text-muted-foreground">
                        되살릴 수 없음
                      </span>
                    )
                  ) : (
                    <ModerationButton
                      target="post"
                      id={post.id}
                      action="delete"
                    />
                  )}
                </li>
              ))}
            </ul>
          ))}

        {replies &&
          (replies.replies.length === 0 ? (
            <p className="p-8 text-center text-sm text-muted-foreground">
              해당하는 답글이 없어요.
            </p>
          ) : (
            <ul>
              {replies.replies.map((reply) => (
                <li
                  key={reply.id}
                  className={`flex flex-wrap items-start justify-between gap-3 border-b border-border p-4 last:border-b-0 ${reply.deletedAt ? "bg-destructive/5" : ""}`}
                >
                  <div className="min-w-0 flex-1 space-y-1">
                    <p className="break-words text-sm">{reply.excerpt}</p>
                    <p className="text-xs text-muted-foreground">
                      <Link
                        href={href({ author: reply.authorLoginName })}
                        className="text-foreground hover:underline"
                      >
                        {reply.authorLoginName}
                      </Link>{" "}
                      · {formatRelative(reply.createdAt)} ·{" "}
                      {reply.postDeleted ? (
                        <span>「{reply.postTitle}」 (삭제된 글)</span>
                      ) : (
                        <Link
                          href={`/board/${reply.postId}#reply-${reply.id}`}
                          className="hover:underline"
                        >
                          「{reply.postTitle}」
                        </Link>
                      )}
                      {reply.deletedAt && (
                        <span className="text-destructive">
                          {" "}
                          · 삭제됨 {formatRelative(reply.deletedAt)}
                        </span>
                      )}
                    </p>
                  </div>
                  {reply.deletedAt ? (
                    <ModerationButton
                      target="reply"
                      id={reply.id}
                      action="restore"
                    />
                  ) : reply.postDeleted ? (
                    <span className="text-xs text-muted-foreground">
                      글이 삭제됨
                    </span>
                  ) : (
                    <ModerationButton
                      target="reply"
                      id={reply.id}
                      action="delete"
                    />
                  )}
                </li>
              ))}
            </ul>
          ))}

        {(page > 1 || hasMore) && (
          <div className="flex justify-center gap-4 border-t border-border p-4 text-sm">
            {page > 1 && (
              <Link
                href={href({ page: page - 1 })}
                className="text-muted-foreground hover:text-foreground"
              >
                ← 이전
              </Link>
            )}
            <span>{page}</span>
            {hasMore && (
              <Link
                href={href({ page: page + 1 })}
                className="text-muted-foreground hover:text-foreground"
              >
                다음 →
              </Link>
            )}
          </div>
        )}
      </section>
    </div>
  );
}
