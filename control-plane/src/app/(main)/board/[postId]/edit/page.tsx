import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { validateRequest } from "@/lib/auth";
import { getPost } from "@/lib/board/posts";
import { filesStillPresent, getTemplateForPost } from "@/lib/board/templates";
import { listCollections } from "@/lib/site-data/service";
import { EditPostForm } from "./EditPostForm";
import { NewVersionForm } from "./NewVersionForm";

export const metadata: Metadata = { title: "글 고치기 · 나루 게시판" };

export default async function EditPostPage({
  params,
}: {
  params: Promise<{ postId: string }>;
}) {
  const { postId } = await params;
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
      postId,
    )
  )
    notFound();
  const { user } = await validateRequest();
  if (!user) redirect("/login");
  const post = await getPost(postId, user);
  if (!post) notFound();
  if (post.userId !== user.id) redirect(`/board/${post.id}`);

  const template =
    post.kind === "template" ? await getTemplateForPost(post.id) : null;
  const collections = template ? await listCollections(user) : [];
  const latest = template?.versions[0] ?? null;
  const previousFiles =
    template && latest
      ? template.files.map((file) => `${latest.sourcePath}${file.path}`)
      : [];
  const presentFiles = latest
    ? await filesStillPresent(user.loginName, latest.sourcePath, previousFiles)
    : [];

  return (
    <div className="bg-background min-h-screen p-4 sm:p-6">
      <main className="mx-auto max-w-3xl space-y-8">
        <div className="space-y-1">
          <Link
            href={`/board/${post.id}`}
            className="text-xs text-primary hover:underline"
          >
            ← 글로 돌아가기
          </Link>
          <h1 className="text-2xl font-bold">글 고치기</h1>
        </div>
        <EditPostForm postId={post.id} title={post.title} body={post.body} />
        {template && latest && (
          <section className="space-y-4 border-2 border-line p-4">
            <div className="space-y-1">
              <h2 className="text-lg font-bold">새 버전 올리기</h2>
              <p className="text-sm text-muted-foreground">
                지금은 v{latest.version}이에요. 체크한 파일의 지금 내용으로 v
                {latest.version + 1}을(를) 만들어요. 이미 적용한 사람의 사이트는
                바뀌지 않아요.
              </p>
            </div>
            <NewVersionForm
              templateId={template.id}
              postId={post.id}
              initialFiles={presentFiles}
              missingFiles={previousFiles.filter(
                (path) => !presentFiles.includes(path),
              )}
              collections={collections.map((c) => c.name)}
              initialCollections={latest.collections.map((c) => c.name)}
            />
          </section>
        )}
      </main>
    </div>
  );
}
