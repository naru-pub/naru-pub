import type { Metadata } from "next";
import type { ReactNode } from "react";
import Code from "../Code";

export const metadata: Metadata = {
  title: "미디어 사용 안내 | 나루",
  description: "나루 미디어 라이브러리와 웹 SDK로 이미지와 파일을 다루는 방법",
};

const sections = [
  ["start", "01 · 미디어 라이브러리에서 시작하기"],
  ["upload", "02 · 웹 SDK로 올리기"],
  ["metadata", "03 · 어떤 글의 파일인지 적어 두기"],
  ["limits", "04 · 한도와 허용 형식"],
  ["cleanup", "05 · 정리와 삭제"],
];

function Section({
  id,
  title,
  children,
}: {
  id: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <section id={id} className="scroll-mt-8 space-y-5 border-t pt-8">
      <h2 className="text-xl font-bold">{title}</h2>
      {children}
    </section>
  );
}

export default function MediaDocs() {
  return (
    <div className="min-h-screen">
      <div className="mx-auto max-w-6xl px-5 py-12 md:px-8">
        <header className="mb-12 max-w-3xl space-y-5">
          <p className="text-sm text-muted-foreground">
            NARU / DOCS / MEDIA / SDK 1.0.0
          </p>
          <h1 className="text-3xl font-bold tracking-tight md:text-4xl">
            사이트가 올린 이미지와 파일을 다루세요.
          </h1>
          <p className="text-lg leading-8 text-muted-foreground">
            글에 넣을 사진, 방명록에 첨부한 이미지처럼 데이터베이스 문서와 함께
            쓰는 파일을 보관합니다.
          </p>
          <div className="flex flex-wrap gap-5 text-sm underline underline-offset-4">
            <a href="/media">미디어 라이브러리 열기 →</a>
            <a href="/docs/database">데이터베이스 사용 안내 →</a>
          </div>
        </header>

        <div className="grid gap-10 lg:grid-cols-[230px_minmax(0,1fr)]">
          <nav
            aria-label="문서 목차"
            className="self-start rounded-lg border p-5 lg:sticky lg:top-8"
          >
            <p className="mb-4 font-bold">이 페이지에서</p>
            <ul className="space-y-3 text-sm">
              {sections.map(([id, label]) => (
                <li key={id}>
                  <a
                    className="underline-offset-4 hover:underline"
                    href={`#${id}`}
                  >
                    {label}
                  </a>
                </li>
              ))}
            </ul>
          </nav>

          <article className="min-w-0 space-y-12 leading-8 [&_a]:underline [&_a]:underline-offset-4">
            <Section id="start" title="01 · 미디어 라이브러리에서 시작하기">
              <p>
                <a href="/media">미디어 라이브러리</a>에서 파일을 끌어 놓아
                올리고, 저장 공간을 확인하고, 이름과 형식으로 검색하거나
                정렬하고, 공개 URL을 복사하고, 파일을 지울 수 있습니다.
              </p>
              <p>
                <strong>홈페이지를 이루는 파일과는 다릅니다.</strong> HTML, CSS,
                직접 올린 사진처럼 사이트 자체를 이루는 파일은{" "}
                <a href="/files">파일</a>에서 관리합니다. 미디어 라이브러리는
                사이트의 코드가 웹 SDK로 올리고 불러오는 파일을 위한 곳이고,
                저장 공간도 한도도 따로 셉니다.
              </p>
              <p>
                올린 파일은 본문과 분리된 <code>media.naru.pub</code> 주소에서
                공개로 제공됩니다.
              </p>
            </Section>

            <Section id="upload" title="02 · 웹 SDK로 올리기">
              <p>
                파일 API는 <strong>관리자 세션에서만</strong> 열립니다. 컬렉션과
                달리 <code>createDatabase()</code>만으로는 쓸 수 없고,{" "}
                <a href="/docs/database#owner">웹사이트에서 관리자 로그인</a>을
                먼저 마쳐야 <code>owner.files</code>를 쓸 수 있습니다.
              </p>
              <p>
                <code>upload()</code>는 10분짜리 서명된 업로드 주소를 받아
                브라우저에서 저장소로 바로 보내고, 나루가 저장된 크기와 형식을
                확인한 뒤 파일을 돌려줍니다. 문서에는 base64 대신 돌아온{" "}
                <code>url</code>이나 <code>id</code>를 저장하세요.
              </p>
              <Code>{`const owner = await db.completeOwnerSignIn();

const image = await owner.files.upload(fileInput.files[0], {
  signal: abortController.signal,
  onProgress: ({ loaded, total }) => showProgress(loaded / total),
});

await owner.collection("posts").set("hello", {
  title: "안녕하세요",
  coverImage: image.url,
});`}</Code>
            </Section>

            <Section id="metadata" title="03 · 어떤 글의 파일인지 적어 두기">
              <p>
                <code>metadata</code>에 넣은 값은 <code>files.list()</code>와{" "}
                <code>files.get()</code>에 그대로 돌아옵니다. 어떤 문서가 그
                파일을 쓰는지 적어 두면, 나중에 글을 지울 때 딸린 파일도 함께
                지워 저장 용량이 새는 것을 막을 수 있습니다.
              </p>
              <Code>{`await owner.files.upload(file, {
  metadata: {
    altText: "비둘기 사진",
    references: [{ collection: "posts", id: "hello", field: "coverImage" }],
  },
});

const files = await owner.files.list();
const mine = files.filter((file) =>
  file.metadata?.references?.some((reference) => reference.id === "hello"),
);`}</Code>
              <p>
                <code>altText</code>는 화면 낭독기를 위한 설명입니다. 문서에
                이미지를 넣을 때 함께 저장해 두면 사이트에서 그대로 쓸 수
                있습니다.
              </p>
            </Section>

            <Section id="limits" title="04 · 한도와 허용 형식">
              <p>
                파일 하나는 <strong>25 MiB</strong>까지, 사이트 하나는{" "}
                <strong>1,000개 · 250 MiB</strong>까지 저장할 수 있습니다.
                데이터베이스 문서 한도와는 별개로 셉니다.
              </p>
              <p>
                JPEG, PNG, WebP, AVIF, GIF와 지원하는 오디오, PDF, ZIP, 일반
                텍스트를 받습니다. <strong>HTML과 SVG는 거절합니다.</strong> 두
                형식은 스크립트를 품을 수 있어, 공개 주소에서 그대로 열리면
                방문자에게 위험할 수 있기 때문입니다.
              </p>
              <Code>{`const { bytes, maxBytes, count, maxFiles } = await owner.files.usage();
showQuota(bytes / maxBytes, count + " / " + maxFiles);`}</Code>
            </Section>

            <Section id="cleanup" title="05 · 정리와 삭제">
              <p>
                <code>files.delete(id)</code>는 저장된 파일과 그 정보를 함께
                지웁니다. <strong>되돌릴 수 없습니다.</strong> 미디어
                라이브러리에서 지울 때도 마찬가지이며, 그 URL을 쓰고 있는 문서가
                있는지는 직접 확인해야 합니다. 지운 파일의 주소를 가리키던
                이미지는 깨집니다.
              </p>
              <Code>{`for (const file of mine) await owner.files.delete(file.id);`}</Code>
              <p>
                끝내 마무리되지 않은 업로드 승인은 한 시간 뒤 배경 정리 작업이
                치웁니다. 계정을 지우면 그 계정의 미디어도 함께 사라집니다.
              </p>
            </Section>
          </article>
        </div>
      </div>
    </div>
  );
}
