import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { validateRequest } from "@/lib/auth";
import { isPostKind } from "@/lib/board/constants";
import { siteDataBackend } from "@/lib/site-data/backend";
import { NewPostForm } from "./NewPostForm";

export const metadata: Metadata = { title: "새 글 쓰기 · 나루 게시판" };

export default async function NewPostPage({
  searchParams,
}: {
  searchParams: Promise<{ kind?: string }>;
}) {
  const { user } = await validateRequest();
  if (!user) redirect("/login");
  const params = await searchParams;

  if (!user.emailVerifiedAt) {
    return (
      <div className="bg-background min-h-screen p-4 sm:p-6">
        <main className="mx-auto max-w-3xl space-y-4 border-2 border-line p-6">
          <h1 className="text-2xl font-bold">새 글 쓰기</h1>
          <p className="text-sm text-muted-foreground">
            게시판에 글을 쓰려면{" "}
            <Link href="/account" className="text-primary hover:underline">
              계정 설정
            </Link>
            에서 이메일을 인증해 주세요.
          </p>
        </main>
      </div>
    );
  }

  const collections = await (
    await siteDataBackend(user.loginName)
  ).collections(user);

  return (
    <div className="bg-background min-h-screen p-4 sm:p-6">
      <main className="mx-auto max-w-3xl space-y-6">
        <div className="space-y-1">
          <Link href="/board" className="text-xs text-primary hover:underline">
            ← 게시판
          </Link>
          <h1 className="text-2xl font-bold">새 글 쓰기</h1>
        </div>
        <NewPostForm
          initialKind={isPostKind(params.kind) ? params.kind : "site"}
          collections={collections.map((c) => c.name)}
        />
      </main>
    </div>
  );
}
