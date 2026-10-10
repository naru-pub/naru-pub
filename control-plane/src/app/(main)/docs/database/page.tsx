import type { Metadata } from "next";
import type { ReactNode } from "react";
import Code from "../Code";
import DocsNav from "../DocsNav";

export const metadata: Metadata = {
  title: "데이터베이스 사용 안내 | 나루",
  description:
    "나루 제어판과 웹 SDK로 블로그, 방명록, 관리자 글쓰기를 만드는 방법",
};

const sections = [
  ["start", "01 · 빠른 시작"],
  ["collections", "02 · 컬렉션과 공개 범위"],
  ["admin", "03 · 관리자 로그인"],
  ["write", "04 · 글 수정과 충돌 처리"],
  ["read", "05 · 목록과 페이지 나누기"],
  ["recipes", "06 · 사용 예"],
  ["errors", "07 · 한도와 오류"],
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

function Table({ head, rows }: { head: string[]; rows: ReactNode[][] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead>
          <tr className="border-b">
            {head.map((cell) => (
              <th key={cell} className="p-3">
                {cell}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={index} className="border-b">
              {row.map((cell, column) => (
                <td key={column} className="p-3">
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function DatabaseDocs() {
  return (
    <div className="min-h-screen">
      <div className="mx-auto max-w-6xl px-5 py-12 md:px-8">
        <DocsNav current="database" />
        <header className="mb-12 max-w-3xl space-y-5">
          <p className="text-sm text-muted-foreground">
            NARU / DOCS / DATABASE / SDK 1.0.0
          </p>
          <h1 className="text-3xl font-bold tracking-tight md:text-4xl">
            정적 웹사이트에 데이터를 더하세요.
          </h1>
          <p className="text-lg leading-8 text-muted-foreground">
            별도 서버 없이 글을 공개하고, 방문자의 인사를 받고, 내 웹사이트에서
            글을 작성하세요.
          </p>
          <div className="flex flex-wrap gap-5 text-sm underline underline-offset-4">
            <a href="/database">데이터베이스 제어판 열기 →</a>
            <a href="https://naru.pub/board?kind=template">템플릿 둘러보기 →</a>
            <a href="/docs/sdk/1.0.0">SDK 레퍼런스 →</a>
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
            <Section id="start" title="01 · 빠른 시작">
              <p>
                <a href="/database">제어판</a>에서 <code>posts</code> 컬렉션을
                만들고 읽기를 공개로 바꾸세요. 제목이 있는 문서를 하나
                저장한 뒤 페이지에 아래 코드를 넣으세요.
              </p>
              <Code language="json">{`{
  "title": "첫 번째 글"
}`}</Code>
              <Code language="html">{`<ul id="posts"></ul>
<script type="module">
  import { createNaru } from "https://naru.pub/sdk/1/naru.js";

  const naru = createNaru();
  const { documents } = await naru.collection("posts").list();
  for (const post of documents) {
    const item = document.createElement("li");
    item.textContent = post.data.title;
    document.querySelector("#posts").append(item);
  }
</script>`}</Code>
              <h3 className="font-bold">방명록에 인사 남기기</h3>
              <p>
                제어판에서 <code>guestbook</code> 컬렉션을 만들고 읽기는
                ‘누구나’, 쓰기는 ‘누구나 생성만’으로 설정하세요.
              </p>
              <Code language="html">{`<button id="hello">인사 남기기</button>
<p id="result"></p>
<script type="module">
  import { createNaru } from "https://naru.pub/sdk/1/naru.js";
  const naru = createNaru();
  const button = document.querySelector("#hello");
  const result = document.querySelector("#result");
  button.onclick = async () => {
    button.disabled = true;
    try {
      const saved = await naru.collection("guestbook").add({
        name: "방문자", message: "안녕하세요!",
      });
      result.textContent = saved.data.message + " 저장됨";
    } catch (error) {
      result.textContent = "결과를 확인하지 못했습니다. 방명록을 확인하세요.";
      console.error(error);
    }
  };
</script>`}</Code>
            </Section>

            <Section id="collections" title="02 · 컬렉션과 공개 범위">
              <p>
                <strong>컬렉션</strong>은 문서를 모으는 곳이고,{" "}
                <strong>문서</strong>는 ID 하나와 JSON 데이터 하나입니다.
                이름과 문서 ID는 영문·숫자·<code>_</code>·<code>-</code>{" "}
                1~64자입니다.
              </p>
              <Table
                head={["", "설정", "방문자가 할 수 있는 일"]}
                rows={[
                  ["읽기", "관리자만", "방문자는 읽을 수 없습니다."],
                  [
                    "읽기",
                    "누구나",
                    <>
                      <code>get</code>·<code>list</code>·<code>count</code>·
                      <code>pages</code>로 누구나 읽습니다.
                    </>,
                  ],
                  ["쓰기", "관리자만", "방문자는 쓸 수 없습니다."],
                  [
                    "쓰기",
                    "누구나 생성만",
                    <>
                      <code>add</code>로 새 문서만 만듭니다. 방명록에
                      알맞습니다.
                    </>,
                  ],
                  [
                    "쓰기",
                    "누구나 생성·덮어쓰기·삭제",
                    "누구나 모든 문서를 바꾸고 지울 수 있습니다. 대부분은 필요 없습니다.",
                  ],
                ]}
              />
              <p>
                관리자는 <a href="#admin">로그인</a>하면 등록한 컬렉션을 공개
                범위와 상관없이 읽고 쓸 수 있습니다. 공개 읽기 컬렉션의 문서는
                누구나 읽을 수 있으니, 비공개로 둘
                데이터는 ‘관리자만’ 읽는 컬렉션에 따로 저장하세요.
              </p>
            </Section>

            <Section id="admin" title="03 · 관리자 로그인">
              <p>
                나루 홈페이지의 소유자가 로그인하면 홈페이지에 로그인할 수 있습니다.
              </p>
              <ol className="list-decimal space-y-3 pl-6">
                <li>
                  제어판의 ‘웹사이트 관리자 로그인’에 관리자 페이지 주소(예:{" "}
                  <code>https://example.naru.pub/</code>)와 쓸
                  컬렉션을 등록합니다.
                </li>
                <li>
                  <code>naru.auth.signIn()</code>으로 로그인하고{" "}
                  <code>naru.auth.session()</code>으로 관리자 클라이언트를
                  받습니다.
                </li>
              </ol>
              <Code language="html">{`<button id="login">관리자 로그인</button>
<p id="auth-status"></p>
<script type="module">
  import { createNaru } from "https://naru.pub/sdk/1/naru.js";
  const naru = createNaru();
  const admin = await naru.auth.session();
  const login = document.querySelector("#login");
  login.hidden = !!admin;
  document.querySelector("#auth-status").textContent =
    admin ? "로그인되었습니다." : "글을 고치려면 로그인하세요.";
  login.onclick = () => naru.auth.signIn({ collections: ["posts", "drafts"] });
  // 다음 예제의 owner는 이 스크립트 안에서 사용하세요.
</script>`}</Code>
            </Section>

            <Section id="write" title="04 · 글 수정과 충돌 처리">
              <Table
                head={["호출", "동작"]}
                rows={[
                  [<code key="c">add(data)</code>, "새 ID로 문서를 만듭니다."],
                  [
                    <code key="c">set(id, data, {"{ condition }"})</code>,
                    "그 ID의 문서를 만들거나 통째로 바꿉니다. 필드를 합치지 않습니다.",
                  ],
                  [
                    <code key="c">delete(id, {"{ condition }"})</code>,
                    "문서를 지웁니다. 없는 문서를 지워도 성공합니다.",
                  ],
                ]}
              />
              <p>
                <code>condition</code>으로 덮어쓰기를 막을 수 있습니다.{" "}
                <code>{"{ revision }"}</code>은 읽은 뒤 바뀌지 않았을 때만,{" "}
                <code>{"{ absent: true }"}</code>는 아직 없는 문서일 때만
                저장하고, 아니면 <code>CONFLICT</code>로 실패합니다.
              </p>
              <Code>{`const post = await admin.collection("posts").get("hello");
try {
  await admin.collection("posts").set(
    "hello",
    { ...post.data, title: "새 제목" },
    { condition: { revision: post.revision } },
  );
} catch (error) {
  if (error.code !== "CONFLICT") throw error;
  alert("다른 곳에서 먼저 저장했습니다. 새로고침 후 다시 시도하세요.");
}`}</Code>
              <p>
                데이터에는 JSON 값만 넣으세요.
              </p>
              <h3 className="font-bold">여러 변경을 함께 저장하기</h3>
              <p>
                <code>admin.batch()</code>은 여러 컬렉션의 <code>set</code>·
                <code>delete</code>를 최대 100개까지 묶어, 원자적으로 반영합니다. 각 변경의 condition도 함께 검사합니다.
                미리 읽은 값이 저절로 보호되는 것은 아니므로 고치는 문서의
                revision을 넘기세요. 결과는 쓴 순서대로, <code>set</code>은{" "}
                <code>{"{ id, revision, createdAt, updatedAt }"}</code>,{" "}
                <code>delete</code>는 <code>null</code>입니다. 
              </p>
              <Code>{`const [saved] = await admin.batch([
  { collection: "posts", set: { id, data: post, condition: { absent: true } } },
  { collection: "drafts", delete: { id, condition: { revision: draft.revision } } },
]);
// saved.revision → 다음 저장의 condition`}</Code>
            </Section>

            <Section id="read" title="05 · 목록과 페이지 나누기">
              <Code>{`const posts = naru.collection("posts");

const post = await posts.get("hello");
// → { id, data, revision, createdAt, updatedAt }

const query = {
  filter: { category: "일상", date: { gte: "2026-09-01" } },
  sort: [["date", "desc"]],
};
const page = await posts.list({ ...query, size: 20 });
// → { documents, nextCursor }

if (page.nextCursor) {
  const next = await posts.list({ ...query, size: 20, after: page.nextCursor });
  console.log(next.documents);
}

// 조건에 맞는 문서 수
const total = await posts.count({ filter: query.filter });

// 끝까지 한 쪽씩 (nextCursor를 대신 따라갑니다)
for await (const { documents } of posts.pages({ ...query, size: 100 })) {
  console.log(documents);
}`}</Code>
              <ul className="list-disc space-y-3 pl-6">
                <li>
                  <strong>filter</strong>: 최상위 필드를 값으로 비교하거나{" "}
                  <code>{"{ gt, gte, lt, lte }"}</code>로 범위를 찾습니다.
                  조건은 모두 만족해야 하며(AND) 최대 5개입니다. 날짜는{" "}
                  <code>&quot;2026-09-01&quot;</code>처럼 자리를 채운 문자열로
                  저장하면 범위로 찾을 수 있습니다.
                </li>
                <li>
                  <strong>sort</strong>: <code>[필드, 방향]</code>을 한두 개
                  넘깁니다. 생성·수정 시각은{" "}
                  <code>{'{ metadata: "createdAt" }'}</code>처럼 씁니다. 기본은
                  ID 오름차순입니다. 같은 날짜에서 최신 글을 먼저 보려면
                  <code>
                    {'[["date", "desc"], [{ metadata: "createdAt" }, "desc"]]'}
                  </code>
                  처럼 두 키를 씁니다. 문자열은 언어별 정렬 없이 유니코드
                  순서로, 숫자는 크기로 비교합니다. 오름차순에서 없는
                  값·null·배열·객체, 문자열, 숫자, 불리언 순입니다.
                </li>
                <li>
                  <strong>size</strong>: 한 번에 기본 50개, 최대 100개입니다.
                  다음 페이지는 같은 filter·sort에 <code>nextCursor</code>를{" "}
                  <code>after</code>로 넘기고, <code>nextCursor</code>가{" "}
                  <code>null</code>이면 끝입니다.{" "}
                  <code>includeTotal: true</code>면 전체 개수도 받습니다. 개수만
                  필요하면 <code>count()</code>를, 모든 쪽이 필요하면{" "}
                  <code>pages()</code>를 쓰세요. 누구나 쓸 수 있는 컬렉션은
                  끝까지 읽지 말고 필요한 만큼만 받으세요.
                </li>
              </ul>
            </Section>

            <Section id="recipes" title="06 · 사용 예">
              <div className="grid gap-4 md:grid-cols-2">
                {[
                  {
                    title: "블로그 글 공개",
                    setup: "posts · 읽기 누구나 / 쓰기 관리자만",
                    code: `naru
  .collection("posts")
  .list({
    sort: [["date", "desc"]],
  });`,
                  },
                  {
                    title: "방명록",
                    setup: "guestbook · 읽기 누구나 / 쓰기 누구나 생성만",
                    code: `naru.collection("guestbook")
  .add({ name, message });`,
                  },
                  {
                    title: "비공개 문의 받기",
                    setup: "inquiries · 읽기 관리자만 / 쓰기 누구나 생성만",
                    code: `naru.collection("inquiries")
  .add({ email, message });`,
                  },
                  {
                    title: "초안 저장 후 공개",
                    setup: "drafts · 읽기 관리자만 / 쓰기 관리자만",
                    code: `admin.batch([
  { collection: "posts",
    set: { id, data, condition: { absent: true } } },
  { collection: "drafts",
    delete: { id, condition: { revision: draft.revision } } },
]);`,
                  },
                  {
                    title: "글에 이미지 붙이기",
                    setup: (
                      <>
                        <a href="/docs/media">미디어 라이브러리</a> · 관리자
                        업로드
                      </>
                    ),
                    code: `const image =
  await admin.media.upload(file);
const posts = admin.collection("posts");
const post = await posts.get(id);
await posts.set(id, { ...post.data, cover: image.url },
  { condition: { revision: post.revision } });`,
                  },
                  {
                    title: "특정 글의 댓글",
                    setup: "comments · 읽기 누구나 / 쓰기 누구나 생성만",
                    code: `naru
  .collection("comments")
  .list({
    filter: { postId: "hello" },
  });`,
                  },
                ].map((recipe) => (
                  <section
                    key={recipe.title}
                    className="min-w-0 space-y-3 rounded-lg border p-5"
                  >
                    <h3 className="font-bold">{recipe.title}</h3>
                    <p className="text-sm text-muted-foreground">
                      {recipe.setup}
                    </p>
                    <pre className="overflow-x-auto rounded bg-muted px-3 py-2 text-xs leading-5">
                      <code>{recipe.code}</code>
                    </pre>
                  </section>
                ))}
              </div>
              <p>
                바로 시작할 수 있는 사이트가 필요하면 게시판의{" "}
                <a href="https://naru.pub/board?kind=template">템플릿</a>을
                둘러보세요.
              </p>
            </Section>

            <Section id="errors" title="07 · 한도와 오류">
              <ul className="list-disc space-y-3 pl-6">
                <li>
                  사이트당 컬렉션 100개, 문서 10,000개, 데이터 10 MiB. 요청
                  하나는 64 KiB까지입니다.
                </li>
                <li>
                  방문자의 <code>add</code>는 분당 횟수가 제한됩니다.
                </li>
                <li>관리자 로그인 페이지는 사이트당 20개까지 등록합니다.</li>
              </ul>
              <p>
                실패하면 <code>NaruError</code>를 던집니다. <code>code</code>로
                구분하세요.
              </p>
              <Table
                head={["code", "뜻"]}
                rows={[
                  ["NOT_FOUND", "문서, 컬렉션 또는 사이트가 없습니다."],
                  [
                    "ACCESS_DENIED",
                    "공개 범위나 등록된 컬렉션이 허용하지 않습니다.",
                  ],
                  [
                    "AUTH_REQUIRED",
                    "관리자 권한이 만료되었습니다. 다시 로그인하세요.",
                  ],
                  ["CONFLICT", "condition이 맞지 않습니다."],
                  [
                    "QUOTA_EXCEEDED",
                    "데이터나 미디어 저장 공간이 가득 찼습니다.",
                  ],
                  [
                    "RATE_LIMITED",
                    "요청이 너무 많습니다. 잠시 후 다시 시도하세요.",
                  ],
                  [
                    "INVALID_REQUEST",
                    "이름, 필터, 크기 등 요청 형식이 잘못되었습니다.",
                  ],
                  ["UNAVAILABLE", "일시적인 오류입니다."],
                ].map(([code, meaning]) => [
                  <code key="c">{code}</code>,
                  meaning,
                ])}
              />
              <Code>{`try {
  await naru.collection("guestbook").add({ message });
} catch (error) {
  status.textContent =
    error.code === "RATE_LIMITED" ? "잠시 후 다시 시도하세요." : error.message;
}`}</Code>
            </Section>
          </article>
        </div>
      </div>
    </div>
  );
}
