import type { Metadata } from "next";
import DocsNav from "./DocsNav";

export const metadata: Metadata = {
  title: "길잡이 | 나루",
  description: "나루의 데이터베이스와 미디어 라이브러리를 쓰는 방법",
};

const guides = [
  {
    href: "/docs/database",
    title: "데이터베이스",
    summary: "컬렉션에 JSON 문서를 저장하고 웹 SDK로 읽고 씁니다.",
  },
  {
    href: "/docs/media",
    title: "미디어",
    summary: "이미지와 파일을 올리고 그 URL을 문서에 저장합니다.",
  },
  {
    href: "/docs/sdk/1.0.0",
    title: "SDK 레퍼런스",
    summary: "웹 SDK의 모든 함수와 타입입니다.",
  },
];

export default function DocsIndex() {
  return (
    <div className="min-h-screen">
      <div className="mx-auto max-w-6xl px-5 py-12 md:px-8">
        <DocsNav current="home" />
        <header className="mb-12 max-w-3xl space-y-5">
          <p className="text-sm text-muted-foreground">NARU / DOCS</p>
          <h1 className="text-3xl font-bold tracking-tight md:text-4xl">
            길잡이
          </h1>
          <p className="text-lg leading-8 text-muted-foreground">
            별도 서버 없이 정적 웹사이트에 데이터와 파일을 더하세요.
          </p>
        </header>

        <div className="grid gap-6 md:grid-cols-3">
          {guides.map((guide) => (
            <a
              key={guide.href}
              href={guide.href}
              className="group block rounded-lg border p-6 transition-colors hover:border-primary hover:bg-primary/5"
            >
              <h2 className="text-xl font-bold group-hover:text-primary">
                {guide.title} →
              </h2>
              <p className="mt-3 leading-7 text-muted-foreground">
                {guide.summary}
              </p>
            </a>
          ))}
        </div>

        <div className="mt-10 flex flex-wrap gap-5 text-sm underline underline-offset-4">
          <a href="/database">데이터베이스 제어판 열기 →</a>
          <a href="/media">미디어 라이브러리 열기 →</a>
          <a href="https://naru.pub/board?kind=template">템플릿 둘러보기 →</a>
        </div>
      </div>
    </div>
  );
}
