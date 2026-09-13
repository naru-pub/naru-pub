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
  ["resize", "03 · 큰 사진은 알아서 줄입니다"],
  ["metadata", "04 · 어떤 글의 파일인지 적어 두기"],
  ["limits", "05 · 한도와 허용 형식"],
  ["cleanup", "06 · 정리와 삭제"],
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
                달리 <code>collection()</code>만으로는 쓸 수 없고,{" "}
                <a href="/docs/database#owner">웹사이트에서 관리자 로그인</a>을
                먼저 마쳐야 <code>owner.files</code>를 쓸 수 있습니다.
              </p>
              <p>
                <code>upload()</code>는 10분짜리 서명된 업로드 주소를 받아
                브라우저에서 저장소로 바로 보내고, 나루가 저장된 크기와 형식을
                확인한 뒤 파일을 돌려줍니다. 문서에는 base64 대신 돌아온{" "}
                <code>url</code>이나 <code>id</code>를 저장하세요.
              </p>
              <Code>{`const owner = await ownerSession();

const image = await owner.files.upload(fileInput.files[0], {
  signal: abortController.signal,
});

await owner.collection("posts").set("hello", {
  title: "안녕하세요",
  coverImage: image.url,
});`}</Code>
            </Section>

            <Section id="resize" title="03 · 큰 사진은 알아서 줄입니다">
              <p>
                요즘 휴대전화 사진은 한 장에 수십 MB, 가로 8000 픽셀을 넘기도
                합니다. <code>upload()</code>는 승인을 받기 전에 브라우저에서
                사진을 줄이므로, 그대로면 한도에 걸렸을 사진도 올라가고 방문자가
                내려받는 양도 줄어듭니다.
              </p>
              <p>
                업로드는 나루를 거치지 않고 브라우저에서 저장소로 바로 가므로,
                사진을 줄일 수 있는 곳은 브라우저뿐입니다. JPEG, PNG, WebP,
                HEIC는 긴 변이 2048 픽셀을 넘거나 파일이{" "}
                <strong>512 KiB</strong>보다 무거울 때, 긴 변 2048 픽셀 이하의
                WebP(만들 수 없는 브라우저에서는 흰 바탕의 JPEG)로 한 번 다시
                저장합니다. 줄인 쪽이 오히려 커지면 원본을 그대로 올립니다.
                아이폰이 저장하는 HEIC는 사파리에서 받는 형식으로 바꿔 주므로,
                원래대로면 거절당했을 사진도 올릴 수 있습니다.
              </p>
              <p>
                다시 저장하면 EXIF가 사라집니다. 회전은 픽셀에 반영해 넣으니
                사진이 눕지 않고, 촬영 위치는 공개 주소에 남지 않습니다. 줄이는
                방식은 고정되어 있어 따로 넘길 설정이 없습니다. 한도는 줄인 뒤의
                크기로 셉니다.
              </p>
              <p>
                <a href="/media">미디어 라이브러리</a>에서 끌어 놓은 파일은
                줄이지 않고 올린 그대로 저장합니다.
              </p>
            </Section>

            <Section id="metadata" title="04 · 어떤 글의 파일인지 적어 두기">
              <p>
                <code>metadata</code>에 넣은 값은 파일을 읽을 때 그대로
                돌아옵니다. 어떤 글이 그 파일을 쓰는지 적어 두면, 나중에 글을
                지울 때 딸린 파일도 함께 지워 저장 용량이 새는 것을 막을 수
                있습니다.
              </p>
              <p>
                <code>files.list()</code>의 <code>where</code>는 이 안의 최상위
                필드를 컬렉션 질의와 똑같은 규칙으로 거릅니다. 찾을 거리를
                스칼라로 담아 두면 서버가 찾아 주므로, 파일 한 장을 찾겠다고
                라이브러리를 통째로 받아 올 일이 없습니다.
              </p>
              <Code>{`await owner.files.upload(file, {
  metadata: { altText: "비둘기 사진", postId: "hello" },
});

// 서버가 찾습니다. 라이브러리를 훑지 않습니다.
const { files } = await owner.files.list({ where: { postId: "hello" } });
for (const file of files) console.log(file.url);`}</Code>
              <p>
                <code>metadata</code>는 올릴 때 정하고 나중에 고칠 수 없습니다.
                찾을 거리가 바뀔 수 있다면 문서 쪽에 파일 주소를 적어 두세요.
              </p>
              <p>
                <code>altText</code>는 화면 낭독기를 위한 설명입니다. 문서에
                이미지를 넣을 때 함께 저장해 두면 사이트에서 그대로 쓸 수
                있습니다.
              </p>
            </Section>

            <Section id="limits" title="05 · 한도와 허용 형식">
              <p>
                파일 하나는 <strong>25 MiB</strong>까지, 사이트 하나는{" "}
                <strong>250 MiB</strong>까지 저장할 수 있습니다. 데이터베이스
                문서 한도와는 별개로 셉니다.
              </p>
              <p>
                JPEG, PNG, WebP, AVIF, GIF와 지원하는 오디오, PDF, ZIP, 일반
                텍스트를 받습니다. <strong>HTML과 SVG는 거절합니다.</strong> 두
                형식은 스크립트를 품을 수 있어, 공개 주소에서 그대로 열리면
                방문자에게 위험할 수 있기 때문입니다.
              </p>
              <p>
                남은 용량은 제어판의 <a href="/media">미디어 라이브러리</a>에서
                확인하세요. 목록은 <code>files.list()</code>가 최근에 올린
                것부터 한 쪽씩, 컬렉션과 똑같이 커서로 돌려줍니다.
              </p>
              <Code>{`const { files, nextPageToken } = await owner.files.list({ limit: 50 });`}</Code>
            </Section>

            <Section id="cleanup" title="06 · 정리와 삭제">
              <p>
                <code>files.delete(id)</code>는 저장된 파일과 그 정보를 함께
                지웁니다. <strong>되돌릴 수 없습니다.</strong> 미디어
                라이브러리에서 지울 때도 마찬가지이며, 그 URL을 쓰고 있는 문서가
                있는지는 직접 확인해야 합니다. 지운 파일의 주소를 가리키던
                이미지는 깨집니다.
              </p>
              <Code>{`const { files } = await owner.files.list({ where: { postId: "hello" } });
for (const file of files) await owner.files.delete(file.id);`}</Code>
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
