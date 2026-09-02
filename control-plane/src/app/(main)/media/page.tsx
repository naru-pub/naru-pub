import Link from "next/link";
import { redirect } from "next/navigation";

import { validateRequest } from "@/lib/auth";
import { userHasFeature } from "@/lib/entitlements";
import MediaLibrary from "./MediaLibrary";

// Media files live in the site data store, so they ride on the same
// entitlement as the database itself.
export default async function MediaPage() {
  const { user } = await validateRequest();
  if (!user) redirect("/login");
  if (!(await userHasFeature(user.id, "database"))) redirect("/account");

  return (
    <div className="mx-auto h-full w-full max-w-7xl space-y-6 overflow-auto p-4 sm:p-6 lg:p-8">
      <header className="flex flex-wrap items-start justify-between gap-4 border-b pb-6">
        <div className="min-w-0 space-y-2">
          <p className="text-sm text-muted-foreground break-all">
            {user.loginName} · 웹 SDK 저장소
          </p>
          <h1 className="text-2xl font-bold tracking-tight">
            미디어 라이브러리
          </h1>
          {/* 파일 and 미디어 both hold files, so the boundary between them is
              stated rather than left to the names. */}
          <p className="max-w-2xl text-sm text-muted-foreground">
            사이트가 웹 SDK로 올리고 불러오는 파일입니다. 방명록 사진이나 글에
            첨부한 이미지처럼, 데이터베이스 문서와 함께 쓰는 파일을 보관합니다.
            홈페이지를 이루는 파일은{" "}
            <Link href="/files" className="text-primary hover:underline">
              파일
            </Link>
            에서 관리합니다.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <a
            href="/database"
            className="border px-4 py-2 text-sm hover:bg-muted"
          >
            데이터베이스 →
          </a>
          <a
            href="/docs/media"
            className="border px-4 py-2 text-sm hover:bg-muted"
          >
            미디어 사용 안내 →
          </a>
        </div>
      </header>

      <MediaLibrary />

      <section className="min-w-0 space-y-3 border p-5">
        <h2 className="font-bold">웹 SDK에서 쓰기</h2>
        <p className="text-sm text-muted-foreground">
          파일 API는 소유자 세션에서만 열립니다. 컬렉션과 달리{" "}
          <code className="bg-muted px-1">createDatabase</code>만으로는 쓸 수
          없고,{" "}
          <Link href="/database" className="text-primary hover:underline">
            웹사이트 관리자 로그인
          </Link>
          을 먼저 마쳐야 합니다.
        </p>
        <pre className="overflow-x-auto bg-muted p-3 text-sm">
          {`const owner = await db.completeOwnerSignIn();
const image = await owner.files.upload(input.files[0]);
// image.url 을 문서에 저장해 두고 그대로 사용합니다.
await owner.files.list();`}
        </pre>
      </section>
    </div>
  );
}
