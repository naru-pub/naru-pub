import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { validateRequest } from "@/lib/auth";
import { isBoardAdmin } from "@/lib/board/access";
import { LICENSES, POST_KIND_LABELS, formatBytes } from "@/lib/board/constants";
import { getPost } from "@/lib/board/posts";
import { listReplies, markPostNotificationsRead } from "@/lib/board/replies";
import {
  getTemplateForPost,
  listTemplateAppliers,
} from "@/lib/board/templates";
import { getHomepageUrl, getRenderedSiteUrl } from "@/lib/site-urls";
import { ApplyTemplateDialog } from "../_components/ApplyTemplateDialog";
import { BoardText } from "../_components/BoardText";
import { KindBadge } from "../_components/KindBadge";
import { LikeButton } from "../_components/LikeButton";
import { PostActions } from "../_components/PostActions";
import { ReplyComposer } from "../_components/ReplyComposer";
import { ReplyThread, type ThreadReply } from "../_components/ReplyThread";
import { Thumbnail } from "../_components/Thumbnail";
import { formatDate, formatRelative } from "../_components/format";
import { PostTitle } from "../_components/PostTitle";
import CollectionName from "@/components/CollectionName";

function parsePostId(value: string): string | null {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
    value,
  )
    ? value
    : null;
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ postId: string }>;
}): Promise<Metadata> {
  const id = parsePostId((await params).postId);
  const post = id ? await getPost(id, null) : null;
  if (!post) return { title: "게시판 · 나루" };
  return {
    title: `${post.title} · 나루 게시판`,
    description: post.body.slice(0, 160),
  };
}

export default async function PostPage({
  params,
}: {
  params: Promise<{ postId: string }>;
}) {
  const id = parsePostId((await params).postId);
  if (!id) notFound();

  const { user } = await validateRequest();
  const post = await getPost(id, user);
  if (!post) notFound();

  const [template, { replies, truncated }] = await Promise.all([
    post.kind === "template" ? getTemplateForPost(post.id) : null,
    listReplies(post.id, user),
  ]);
  const appliers = template
    ? await listTemplateAppliers(template.id)
    : new Map<string, number>();
  if (user) await markPostNotificationsRead(user.id, post.id);

  const viewer = user
    ? {
        id: user.id,
        isAdmin: isBoardAdmin(user),
        canWrite: !!user.emailVerifiedAt,
      }
    : null;
  const threadReplies: ThreadReply[] = replies.map((reply) => ({
    id: reply.id,
    parentId: reply.parentId,
    depth: reply.depth,
    body: reply.body,
    userId: reply.userId,
    authorLoginName: reply.authorLoginName,
    time: formatRelative(reply.createdAt),
    edited: reply.editedAt !== null,
    likeCount: reply.likeCount,
    likedByViewer: reply.likedByViewer,
    appliedVersion: appliers.get(reply.userId) ?? null,
  }));

  const latest = template?.versions[0] ?? null;
  const siteUrl = getHomepageUrl(post.authorLoginName);
  const heroImage = latest
    ? latest.previewUrl
    : post.kind === "site" && post.authorSiteRenderedAt
      ? getRenderedSiteUrl(post.authorLoginName, post.authorSiteRenderedAt)
      : null;
  const showHero = post.kind === "site" || post.kind === "template";

  return (
    <div className="bg-background min-h-screen p-4 sm:p-6">
      {/* Two columns on wide screens: the post above its replies on the
          left, the sidebar beside both. Stacked, the order is the source
          order: post, sidebar, replies. */}
      <div
        className={`mx-auto grid max-w-7xl grid-cols-1 gap-6 ${showHero ? "lg:grid-cols-[minmax(0,1fr)_20rem] lg:grid-rows-[auto_1fr]" : ""}`}
      >
        <main className="min-w-0 space-y-6 lg:col-start-1 lg:row-start-1">
          <nav
            aria-label="위치"
            className="flex gap-2 text-xs text-muted-foreground"
          >
            <Link href="/board" className="text-primary hover:underline">
              게시판
            </Link>
            <span>/</span>
            <Link
              href={`/board?kind=${post.kind}`}
              className="text-primary hover:underline"
            >
              {POST_KIND_LABELS[post.kind]}
            </Link>
          </nav>

          <article className="border-2 border-line bg-card">
            <header className="space-y-3 border-b border-border p-5">
              <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <KindBadge kind={post.kind} />
                {post.solvedReplyId && (
                  <span className="bg-success/10 px-2 py-0.5 text-success">
                    해결됨
                  </span>
                )}
                <span>{formatRelative(post.createdAt)}</span>
                {post.editedAt && <span>(고침)</span>}
              </div>
              <h1 className="break-words text-2xl font-bold sm:text-3xl">
                <PostTitle title={post.title} />
              </h1>
              <div className="flex items-center gap-3 text-sm">
                <span className="font-bold">{post.authorLoginName}</span>
                <a
                  href={siteUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs text-primary hover:underline"
                >
                  {siteUrl.replace(/^https?:\/\//, "")} ↗
                </a>
              </div>
            </header>

            <div className="space-y-5 p-5">
              {post.body && (
                <BoardText
                  text={post.body}
                  className="space-y-3 text-[15px] leading-7 text-foreground/90"
                />
              )}
              <div className="flex flex-wrap items-center gap-2">
                <LikeButton
                  url={`/api/board/posts/${post.id}/like`}
                  initialLiked={post.likedByViewer}
                  initialCount={post.likeCount}
                  signedIn={!!user}
                />
                <PostActions
                  postId={post.id}
                  canEdit={!!user && user.id === post.userId}
                  canDelete={
                    !!user && (user.id === post.userId || isBoardAdmin(user))
                  }
                  isTemplate={post.kind === "template"}
                />
              </div>
            </div>
          </article>
        </main>

        {showHero && (
          <aside className="min-w-0 space-y-5 lg:col-start-2 lg:row-span-2 lg:row-start-1 lg:self-start">
            <figure className="border-2 border-line bg-card">
              <figcaption className="flex items-center justify-between gap-2 border-b-2 border-line bg-secondary px-3 py-2 text-xs text-muted-foreground">
                <span className="truncate">
                  {latest
                    ? `미리보기 · v${latest.version}`
                    : siteUrl.replace(/^https?:\/\//, "")}
                </span>
              </figcaption>
              <Thumbnail
                url={heroImage}
                alt={`${post.title} 미리보기`}
                className="border-0"
              />
            </figure>
            {post.kind === "site" && (
              <a
                href={siteUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="flex h-12 w-full items-center justify-center bg-primary text-base font-bold text-primary-foreground hover:bg-primary/90"
              >
                사이트 방문 ↗
              </a>
            )}
            {template && latest && (
              <>
                <section className="space-y-3 border-2 border-primary bg-primary/5 p-4">
                  <ApplyTemplateDialog
                    title={post.title}
                    slug={template.slug}
                    authorLoginName={post.authorLoginName}
                    samplePath={
                      template.files.find((f) => f.path === "index.html")
                        ?.path ??
                      template.files[0]?.path ??
                      "index.html"
                    }
                    versions={template.versions.map((v) => ({
                      id: v.id,
                      version: v.version,
                    }))}
                    siteUrl={user ? getHomepageUrl(user.loginName) : null}
                  />
                  <div className="border border-border bg-background p-3">
                    <div className="text-xl font-bold text-primary">
                      {template.applyCount}
                    </div>
                    <div className="text-xs text-muted-foreground">적용</div>
                  </div>
                </section>

                <section className="border-2 border-line bg-card">
                  <h2 className="border-b-2 border-line bg-secondary px-4 py-3 font-bold">
                    정보
                  </h2>
                  <dl className="grid grid-cols-[5.5rem_1fr] gap-y-2 p-4 text-xs">
                    <dt className="text-muted-foreground">이름</dt>
                    <dd className="break-all">
                      {post.authorLoginName}/{template.slug}
                    </dd>
                    <dt className="text-muted-foreground">버전</dt>
                    <dd>
                      v{latest.version} · {formatDate(latest.createdAt)}
                    </dd>
                    <dt className="text-muted-foreground">라이선스</dt>
                    <dd>{LICENSES[template.license]}</dd>
                    <dt className="text-muted-foreground">크기</dt>
                    <dd>
                      파일 {latest.fileCount}개 ·{" "}
                      {formatBytes(latest.sizeBytes)}
                    </dd>
                  </dl>
                </section>

                <section className="border-2 border-line bg-card">
                  <h2 className="border-b-2 border-line bg-secondary px-4 py-3 font-bold">
                    포함된 파일
                  </h2>
                  <ul className="max-h-80 overflow-y-auto p-4 text-xs leading-6">
                    {template.files.map((file) => (
                      <li
                        key={file.path}
                        className="flex justify-between gap-2"
                      >
                        <span className="break-all">{file.path}</span>
                        <span className="shrink-0 text-muted-foreground">
                          {formatBytes(file.sizeBytes)}
                        </span>
                      </li>
                    ))}
                  </ul>
                </section>

                {latest.collections.length > 0 && (
                  <section className="space-y-2 border-2 border-line bg-card p-4 text-xs leading-relaxed">
                    <h2 className="text-sm font-bold">필요한 기능</h2>
                    <p className="text-muted-foreground">
                      데이터베이스 — 적용할 때 빈 컬렉션{" "}
                      {latest.collections.map((c, index) => (
                        <span key={c.name}>
                          {index > 0 && ", "}
                          <code className="bg-secondary px-1 text-foreground">
                            <CollectionName name={c.name} />
                          </code>
                        </span>
                      ))}
                      을(를) 만들어요.
                    </p>
                  </section>
                )}

                {template.versions.length > 1 && (
                  <section className="border-2 border-line bg-card">
                    <h2 className="border-b-2 border-line bg-secondary px-4 py-3 font-bold">
                      버전 기록
                    </h2>
                    <ol className="space-y-3 p-4 text-xs">
                      {template.versions.map((version) => (
                        <li key={version.id} className="space-y-1">
                          <div className="font-bold">
                            v{version.version}{" "}
                            <span className="font-normal text-muted-foreground">
                              {formatDate(version.createdAt)}
                            </span>
                          </div>
                          {version.changelog && (
                            <p className="whitespace-pre-wrap text-muted-foreground">
                              {version.changelog}
                            </p>
                          )}
                        </li>
                      ))}
                    </ol>
                  </section>
                )}
              </>
            )}
          </aside>
        )}

        <section
          aria-labelledby="replies-title"
          className="min-w-0 space-y-4 lg:col-start-1 lg:row-start-2"
        >
          <h2 id="replies-title" className="text-lg font-bold">
            답글 {post.replyCount}
          </h2>
          {viewer?.canWrite ? (
            <ReplyComposer
              postId={post.id}
              parentId={null}
              label={`${user!.loginName} 로 답글 쓰기`}
            />
          ) : (
            <p className="border border-border p-4 text-sm text-muted-foreground">
              {user ? (
                <>
                  답글을 쓰려면{" "}
                  <Link
                    href="/account"
                    className="text-primary hover:underline"
                  >
                    이메일을 인증
                  </Link>
                  해 주세요.
                </>
              ) : (
                <>
                  답글을 쓰려면{" "}
                  <Link href="/login" className="text-primary hover:underline">
                    로그인
                  </Link>
                  해 주세요.
                </>
              )}
            </p>
          )}
          <ReplyThread
            postId={post.id}
            postAuthorId={post.userId}
            replies={threadReplies}
            viewer={viewer}
            isQuestion={post.kind === "question"}
            solvedReplyId={post.solvedReplyId}
          />
          {truncated && (
            <p className="text-sm text-muted-foreground">
              답글이 너무 많아 일부만 보여요. 각 답글의 시간을 누르면 그
              답글부터 이어서 볼 수 있어요.
            </p>
          )}
        </section>
      </div>
    </div>
  );
}
