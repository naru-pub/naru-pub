import type { Metadata } from "next";
import Link from "next/link";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { tabLinkClass } from "@/components/ui/tab-link";
import { validateRequest } from "@/lib/auth";
import {
  POST_KINDS,
  POST_KIND_LABELS,
  isPostKind,
  type PostKind,
  type PostSort,
} from "@/lib/board/constants";
import { listPopularTemplatePosts, listPosts } from "@/lib/board/posts";
import { countUnreadNotifications } from "@/lib/board/replies";
import { PostRow } from "./_components/PostRow";
import { PostTitle } from "./_components/PostTitle";
import { Thumbnail, postThumbnailUrl } from "./_components/Thumbnail";

export const metadata: Metadata = {
  title: "게시판 · 나루",
  description: "나루 사람들의 사이트, 템플릿, 그리고 이야기.",
};

const SORT_LABELS: Record<PostSort, string> = {
  activity: "최근 활동순",
  new: "새 글순",
  applied: "적용 많은순",
};

// `database` filters templates to those that use the site database; the
// database docs link to it.
function boardHref(
  kind: PostKind | null,
  sort: PostSort,
  page = 1,
  database = false,
) {
  const params = new URLSearchParams();
  if (kind) params.set("kind", kind);
  if (sort !== "activity") params.set("sort", sort);
  if (database && kind === "template") params.set("database", "1");
  if (page > 1) params.set("page", String(page));
  const query = params.toString();
  return query ? `/board?${query}` : "/board";
}

export default async function BoardPage({
  searchParams,
}: {
  searchParams: Promise<{
    kind?: string;
    sort?: string;
    page?: string;
    database?: string;
  }>;
}) {
  const params = await searchParams;
  const kind = isPostKind(params.kind) ? params.kind : null;
  const sorts: PostSort[] =
    kind === "template" ? ["activity", "new", "applied"] : ["activity", "new"];
  const sort = sorts.includes(params.sort as PostSort)
    ? (params.sort as PostSort)
    : "activity";
  const page = Math.max(1, Number.parseInt(params.page ?? "1", 10) || 1);
  const database = kind === "template" && params.database === "1";

  const { user } = await validateRequest();
  const [{ posts, hasMore }, popular, unread] = await Promise.all([
    listPosts({ kind, sort, page, usesDatabase: database }),
    listPopularTemplatePosts(4),
    user ? countUnreadNotifications(user.id) : null,
  ]);

  return (
    <div className="bg-background min-h-screen p-4 sm:p-6">
      <div className="mx-auto max-w-7xl space-y-6">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="space-y-1">
            <h1 className="text-3xl font-bold text-foreground">게시판</h1>
            <p className="text-sm text-muted-foreground">
              나루 사람들의 사이트, 템플릿, 그리고 이야기.
            </p>
          </div>
          <Button asChild>
            <Link href={kind ? `/board/new?kind=${kind}` : "/board/new"}>
              <Plus aria-hidden="true" />새 글 쓰기
            </Link>
          </Button>
        </div>

        <div className="flex flex-col gap-6 lg:flex-row lg:items-start">
          <section className="min-w-0 flex-1 border-2 border-line bg-card">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-2">
              <nav
                aria-label="글 종류"
                className="flex min-w-0 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
              >
                {[null, ...POST_KINDS].map((value) => (
                  <Link
                    key={value ?? "all"}
                    href={boardHref(
                      value,
                      value === "template"
                        ? sort
                        : sort === "applied"
                          ? "activity"
                          : sort,
                    )}
                    aria-current={value === kind ? "page" : undefined}
                    className={tabLinkClass(value === kind)}
                  >
                    {value ? POST_KIND_LABELS[value] : "전체"}
                  </Link>
                ))}
              </nav>
              <nav aria-label="정렬" className="flex gap-3 px-2 py-2 text-xs">
                {kind === "template" && (
                  <Link
                    href={boardHref(kind, sort, 1, !database)}
                    aria-pressed={database}
                    className={
                      database
                        ? "font-bold text-foreground"
                        : "text-muted-foreground hover:text-foreground"
                    }
                  >
                    {database ? "✓ " : ""}데이터베이스 사용
                  </Link>
                )}
                {sorts.map((value) => (
                  <Link
                    key={value}
                    href={boardHref(kind, value, 1, database)}
                    aria-current={value === sort ? "true" : undefined}
                    className={
                      value === sort
                        ? "font-bold text-foreground"
                        : "text-muted-foreground hover:text-foreground"
                    }
                  >
                    {SORT_LABELS[value]}
                  </Link>
                ))}
              </nav>
            </div>

            {posts.length === 0 ? (
              <p className="p-10 text-center text-sm text-muted-foreground">
                아직 글이 없어요. 첫 글을 써 보세요!
              </p>
            ) : (
              posts.map((post) => <PostRow key={post.id} post={post} />)
            )}

            {(page > 1 || hasMore) && (
              <div className="flex justify-center gap-4 border-t border-border p-4 text-sm">
                {page > 1 && (
                  <Link
                    href={boardHref(kind, sort, page - 1, database)}
                    className="text-muted-foreground hover:text-foreground"
                  >
                    ← 이전
                  </Link>
                )}
                <span className="text-foreground">{page}</span>
                {hasMore && (
                  <Link
                    href={boardHref(kind, sort, page + 1, database)}
                    className="text-muted-foreground hover:text-foreground"
                  >
                    다음 →
                  </Link>
                )}
              </div>
            )}
          </section>

          <aside className="w-full space-y-6 lg:w-80 lg:shrink-0">
            {unread && unread.count > 0 && (
              <section className="space-y-2 border-2 border-primary bg-primary/5 p-4">
                <p className="text-xs text-muted-foreground">
                  {user!.loginName}@naru:~$ notify
                </p>
                <Link
                  href="/board/notifications"
                  className="block font-bold text-primary hover:underline"
                >
                  새 답글 {unread.count}개 →
                </Link>
                <p className="text-xs text-muted-foreground">
                  {unread.from.join(", ")} 님이 답글을 달았어요
                </p>
              </section>
            )}

            {popular.length > 0 && (
              <section className="border-2 border-line bg-card">
                <h2 className="border-b-2 border-line bg-secondary px-4 py-3 font-bold">
                  인기 템플릿
                </h2>
                <ul>
                  {popular.map((post) => (
                    <li key={post.id} className="border-b border-border">
                      <Link
                        href={`/board/${post.id}`}
                        className="flex items-center gap-3 px-4 py-3 hover:bg-accent"
                      >
                        <Thumbnail
                          url={postThumbnailUrl(post)}
                          alt=""
                          className="w-14 shrink-0"
                        />
                        <span className="min-w-0 space-y-1">
                          <span className="block truncate text-sm font-bold">
                            <PostTitle title={post.title} />
                          </span>
                          <span className="block text-xs text-muted-foreground">
                            {post.authorLoginName} ·{" "}
                            <span className="text-primary">
                              {post.template?.applyCount ?? 0}회 적용
                            </span>
                          </span>
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
                <Link
                  href="/board?kind=template&sort=applied"
                  className="block px-4 py-3 text-sm text-primary hover:underline"
                >
                  템플릿 모두 보기 →
                </Link>
              </section>
            )}

            <section className="border-2 border-line bg-card">
              <h2 className="border-b-2 border-line bg-secondary px-4 py-3 font-bold">
                게시판 안내
              </h2>
              <div className="space-y-3 p-4 text-sm leading-relaxed text-muted-foreground">
                <p>
                  <strong className="text-foreground">사이트 자랑</strong> — 내
                  나루 사이트를 소개해 주세요. 스크린샷은 자동으로 붙어요.
                </p>
                <p>
                  <strong className="text-foreground">템플릿</strong> — 내
                  폴더를 템플릿으로 공유하면, 다른 사람이 버튼 한 번으로 자기
                  사이트에 적용할 수 있어요. 새 템플릿은 연합우주 팔로워에게도
                  알려져요.
                </p>
                <p>
                  <strong className="text-foreground">답글</strong> — 답글에
                  답글을 달 수 있어요. 글을 쓰려면 이메일 인증이 필요해요.
                </p>
              </div>
            </section>
          </aside>
        </div>
      </div>
    </div>
  );
}
