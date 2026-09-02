import type { Metadata } from "next";
import type { ReactNode } from "react";
import Code from "./Code";

export const metadata: Metadata = {
  title: "데이터베이스 사용 안내 | 나루",
  description:
    "나루 제어판과 웹 SDK로 블로그, 방명록, 관리자 글쓰기를 만드는 방법",
};
const sections = [
  ["start", "01 · 제어판에서 시작하기"],
  ["permissions", "02 · 공개 범위 정하기"],
  ["sdk", "03 · 웹 SDK 사용하기"],
  ["owner", "04 · 웹사이트에서 관리자 로그인"],
  ["example", "05 · 예제 블로그 설치"],
  ["limits", "06 · 한도와 문제 해결"],
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
export default function DatabaseDocs() {
  return (
    <div className="h-full overflow-auto">
      <div className="mx-auto max-w-6xl px-5 py-12 md:px-8">
        <header className="mb-12 max-w-3xl space-y-5">
          <p className="text-sm text-muted-foreground">
            NARU / DATABASE / SDK 1.0.0
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
            <a href="/database/docs/blog.zip">예제 블로그 ZIP 내려받기 ↓</a>
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
            <Section id="start" title="01 · 제어판에서 시작하기">
              <p>
                데이터베이스는 사이트별 JSON 문서 저장소입니다.{" "}
                <strong>컬렉션</strong>은 문서를 모으는 공간이고,{" "}
                <strong>문서</strong>는 고유 ID와 JSON 데이터 한 개입니다.
                관리자는 해당 나루 계정의 소유자입니다.
              </p>
              <ol className="list-decimal space-y-3 pl-6">
                <li>
                  <a href="/database">/database</a>로 이동해 나루에
                  로그인합니다.
                </li>
                <li>
                  컬렉션 이름에 <code>posts</code>를 입력하고 ‘컬렉션 만들기’를
                  누릅니다. 이름과 문서 ID는 영문 대소문자·숫자·밑줄·하이픈
                  1~64자입니다.
                </li>
                <li>
                  컬렉션을 선택해 읽기와 쓰기 권한을 각각 설정합니다. 새
                  컬렉션은 관리자만 읽고 쓸 수 있습니다.
                </li>
                <li>
                  문서 ID와 JSON을 입력해 저장합니다. 기존 문서를 선택해
                  편집하거나 삭제할 수도 있습니다. 같은 ID로 저장하면 문서
                  전체를 교체합니다.
                </li>
              </ol>
              <p>
                문서 ID: <code>hello</code>
              </p>
              <Code language="json">{`{\n  "title": "첫 번째 글",\n  "body": "안녕하세요, 나루!"\n}`}</Code>
              <p>
                컬렉션 생성·삭제와 권한 설정은 제어판에서 합니다. 웹사이트에
                부여한 관리자 권한은 선택한 컬렉션의 문서 읽기·쓰기만
                허용합니다.
              </p>
            </Section>
            <Section id="permissions" title="02 · 공개 범위 정하기">
              <p>
                읽기와 쓰기는 독립적인 설정입니다. 공개 쓰기를 허용해도 읽기가
                자동으로 공개되지는 않습니다.
              </p>
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <caption className="pb-3 text-left font-bold">
                    블로그 예제의 컬렉션 설정
                  </caption>
                  <thead>
                    <tr className="border-b">
                      <th className="p-3">컬렉션</th>
                      <th className="p-3">읽기</th>
                      <th className="p-3">쓰기</th>
                      <th className="p-3">용도</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr className="border-b">
                      <td className="p-3">posts</td>
                      <td className="p-3">공개 (world)</td>
                      <td className="p-3">관리자 (admin)</td>
                      <td className="p-3">공개된 블로그 글</td>
                    </tr>
                    <tr className="border-b">
                      <td className="p-3">guestbook</td>
                      <td className="p-3">공개 (world)</td>
                      <td className="p-3">공개 생성만 (create)</td>
                      <td className="p-3">누구나 남기는 인사</td>
                    </tr>
                    <tr className="border-b">
                      <td className="p-3">drafts</td>
                      <td className="p-3">관리자 (admin)</td>
                      <td className="p-3">관리자 (admin)</td>
                      <td className="p-3">비공개 초안</td>
                    </tr>
                  </tbody>
                </table>
              </div>
              <ul className="list-disc space-y-3 pl-6">
                <li>
                  <strong>관리자 쓰기 (admin)</strong>: 소유자만
                  생성·교체·삭제할 수 있습니다.
                </li>
                <li>
                  <strong>공개 생성만 (create)</strong>: 방문자는{" "}
                  <code>add()</code>로 새 문서만 만들 수 있습니다. ID는 서버가
                  발급합니다. 방문자가 자신이 쓴 문서를 수정하거나 삭제하는
                  기능은 없습니다.
                </li>
                <li>
                  <strong>전체 공개 쓰기 (world)</strong>: 누구나 모든 문서를
                  생성·덮어쓰기·삭제할 수 있습니다. 방명록에는 권장하지
                  않습니다.
                </li>
              </ul>
              <aside className="rounded-lg border p-5">
                <strong>공개 컬렉션에 비밀을 저장하지 마세요.</strong>
                <p>
                  화면에서 숨긴 필드도 API로 읽을 수 있습니다.{" "}
                  <code>published: false</code>는 접근 규칙이 아닙니다. 비공개
                  초안은 관리자 읽기·쓰기 컬렉션에 분리하세요. 승인형 댓글은
                  관리자 읽기·공개 생성 컬렉션으로 받은 후, 관리자가 별도의 공개
                  컬렉션으로 옮기는 방식으로 만듭니다.
                </p>
              </aside>
              <p>
                공개 입력에는 스팸이나 거짓 이름이 포함될 수 있습니다. 생성
                전용은 덮어쓰기를 막지만 본인 인증이나 스팸 차단을 제공하지
                않습니다. 방문자가 넣은 문자열은 <code>textContent</code>로
                표시하고 HTML로 실행하지 마세요.
              </p>
            </Section>
            <Section id="sdk" title="03 · 웹 SDK 사용하기">
              <p>
                빌드 도구 없이 HTML의 모듈 스크립트에서 사용할 수 있습니다.{" "}
                <code>site</code>에는 전체 도메인이 아니라 나루 로그인 이름을
                넣으세요. 공개 작업에는 API 키가 필요 없습니다.
              </p>
              <Code language="html">{`<script type="module">\n  import { createDatabase } from "https://naru.pub/sdk/1.0.0/naru-data.js";\n  const db = createDatabase({ site: "내-로그인-이름" });\n  const posts = db.collection("posts");\n  const sort = { orderBy: "created_at", direction: "desc" };\n  const page = await posts.list({ ...sort, limit: 20 });\n  for (const document of page.documents) {\n    console.log(document.id, document.data, document.created_at);\n  }\n  if (page.nextCursor) {\n    const next = await posts.list({ ...sort, limit: 20, after: page.nextCursor });\n  }\n  const post = await posts.get("hello");\n  await db.collection("guestbook").add({\n    name: "방문자", message: "잘 읽었습니다!"\n  });\n</script>`}</Code>
              <p>
                현재 제공 버전은 <strong>1.0.0</strong>이며 이 버전 안에서 계속
                개선합니다. 버전 없는 URL은 제공하지 않습니다. 제어판 주소는
                SDK에
                <code>https://naru.pub</code>로 고정되어 별도 설정이 필요
                없습니다. 자체 번들로 옮겨도 같습니다.{" "}
                <a href="/sdk/1.0.0/naru-data.d.ts">TypeScript 타입 정의</a>도
                제공합니다.
              </p>
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <caption className="pb-3 text-left font-bold">
                    컬렉션 메서드 — 모두 Promise를 반환합니다
                  </caption>
                  <thead>
                    <tr className="border-b">
                      <th className="p-3">호출</th>
                      <th className="p-3">동작 / 반환값</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[
                      [
                        "get(id)",
                        "문서 한 개 → { id, data, created_at, updated_at, version }. 없으면 404",
                      ],
                      [
                        "list({ limit, after, orderBy, direction, where })",
                        "{ documents, nextCursor }. 기본 50개, 최대 100개",
                      ],
                      [
                        "all({ limit, orderBy, direction, where })",
                        "조건에 맞는 모든 문서를 필요할 때마다 한 페이지씩 가져오는 async iterator",
                      ],
                      [
                        "count({ where })",
                        "조건에 맞는 문서 개수를 서버에서 계산 → 숫자",
                      ],
                      ["add(data)", "서버 ID로 새 문서 생성 → { id, version }"],
                      [
                        "set(id, data, { ifVersion })",
                        "지정 ID로 생성 또는 전체 교체 → { id, version }",
                      ],
                      [
                        "update(id, patch, { unset, ifVersion })",
                        "지정한 필드만 병합하고 unset에 적은 필드는 삭제 → { id, version }. 문서가 없으면 404",
                      ],
                      [
                        "delete(id, { ifVersion })",
                        "문서 삭제 → { success: true }",
                      ],
                    ].map(([call, result]) => (
                      <tr className="border-b" key={call}>
                        <td className="p-3">
                          <code>{call}</code>
                        </td>
                        <td className="p-3">{result}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <h3 id="filters" className="font-bold">
                필터와 자동 인덱스
              </h3>
              <p>
                <code>where</code>로 JSON의 최상위 필드를 정확히 비교할 수
                있습니다. 여러 조건은 모두 만족해야 합니다(AND). 예를 들어
                분류별 글이나 특정 글에 달린 댓글을 찾을 수 있습니다.
              </p>
              <Code>{`const query = {
  where: { category: "일상" },
  orderBy: "created_at",
  direction: "desc",
  limit: 20,
};
const page = await db.collection("posts").list(query);
if (page.nextCursor !== null) {
  const next = await db.collection("posts").list({
    ...query, after: page.nextCursor,
  });
}

// comments 컬렉션을 따로 만든 경우:
const comments = await db.collection("comments").list({
  where: { postId: "hello", approved: true },
});`}</Code>
              <p>
                필드 이름은 영문·숫자·밑줄·하이픈 1~64자이며, 값은
                문자열·숫자·불리언·null만 가능합니다. 최대 5개 조건, 필터 JSON
                전체 2,048바이트까지 지원합니다. <code>1</code>과{" "}
                <code>&quot;1&quot;</code>은 다릅니다. 문자열은 대소문자를
                포함해 정확히 비교하며 <code>null</code>은 실제 null 필드만
                찾습니다. 필드가 없는 문서는 일치하지 않습니다.
              </p>
              <p>
                값 대신 <code>{"{ gte, gt, lte, lt }"}</code> 형태의 비교 객체를
                넘기면 범위로 찾습니다. 달력처럼 기간을 보여주는 화면은 전체
                문서를 받아 걸러내는 대신 필요한 구간만 요청할 수 있습니다.
              </p>
              <Code>{`// 2026년 9월에 쓴 글만 가져옵니다.
const page = await db.collection("posts").list({
  where: { date: { gte: "2026-09-01", lte: "2026-09-30" } },
  orderBy: "data.date",
});

// 등호 조건과 범위 조건을 함께 쓸 수 있습니다.
const mine = await db.collection("posts").list({
  where: { categoryId: "diary", score: { gte: 10, lt: 100 } },
});`}</Code>
              <p>
                비교 대상은 문자열 또는 숫자이며, 한 필드의 두 경계는 같은
                종류여야 합니다. 비교는 같은 종류끼리만 이루어지므로 문자열
                조건이 숫자 필드를 찾아내는 일은 없고, 해당 필드가 없는 문서는
                결과에 포함되지 않습니다. 날짜는 <code>2026-09-01</code>처럼
                자리를 채운 문자열로 저장해야 사전순 비교가 날짜순과 일치합니다.
                등호 하나와 범위 경계 하나가 각각 조건 한 개로 세어지며, 합쳐서
                최대 5개입니다.
              </p>
              <p>
                중첩 경로·배열 검색·OR·부분 문자열 검색은 아직 지원하지
                않습니다. 빈 <code>where: {"{}"}</code> 또는 where 생략은 전체
                목록을 뜻합니다. 필터 값은 URL에 들어가므로 비밀번호 같은 비밀을
                넣지 마세요.
              </p>
              <p>
                나루가 JSON 필터용 GIN 인덱스와 생성·수정 시각 정렬용 인덱스를
                자동으로 유지합니다. 필드별 인덱스를 직접 생성할 필요가 없으며,
                문서 저장·수정·삭제 시 함께 갱신됩니다. 등호 조건은 이 인덱스를
                사용하고, 범위 비교와 JSON 필드 정렬은 컬렉션 안을 훑습니다.
                사이트당 문서 한도(10,000개) 안에서는 충분히 빠르지만, 자주 쓰는
                조건은 등호로 좁힌 뒤 범위를 더하는 편이 좋습니다.
              </p>
              <p>
                <strong>필터는 접근 권한이 아닙니다.</strong> 방문자는 where를
                빼거나 바꿀 수 있습니다. <code>approved: true</code>로 화면에서
                숨겨도 공개 컬렉션의 미승인 댓글은 읽을 수 있습니다. 비공개
                데이터는 관리자 읽기 컬렉션에 분리하세요.
              </p>
              <h3 className="font-bold">정렬과 페이지 이동</h3>
              <p>
                기본 정렬은 ID 오름차순입니다. <code>orderBy</code>는{" "}
                <code>id</code>, <code>created_at</code>(서버 생성 시각),{" "}
                <code>updated_at</code>(서버 수정 시각), 그리고 문서의 최상위
                필드를 뜻하는 <code>data.필드이름</code> 중 하나이며,{" "}
                <code>direction</code>은 <code>asc</code>(기본값) 또는{" "}
                <code>desc</code>입니다. 방명록은 <code>created_at</code>{" "}
                내림차순으로 최신 글부터 표시합니다. 글쓴이가 날짜를 직접 정하는
                블로그라면 <code>orderBy: &quot;data.date&quot;</code>로
                정렬해야 나중에 쓴 지난 날짜 글이 맨 위로 올라오지 않습니다.
              </p>
              <p>
                <code>data.필드이름</code>으로 정렬하면 값이 없는 문서는 JSON
                null과 같은 자리에 놓이고, null·문자열·숫자 순으로 정렬합니다.
                값이 같은 문서는 같은 방향의 ID 순서로 정렬합니다. 다음
                페이지에는 응답의 <code>nextCursor</code>를 그대로{" "}
                <code>after</code>로 보내고, 같은 컬렉션·정렬 필드·방향·필터를
                유지하세요. 커서를 직접 해석하거나 만들지 마세요. 다른 정렬이나
                필터에 사용하면 400 오류가 발생합니다. 정렬이나 필터를 바꾸려면
                커서와 기존 목록을 비우고 첫 페이지부터 다시 불러오세요.
              </p>
              <p>
                <code>nextCursor</code>가 <code>null</code>이면 마지막
                페이지입니다. 이전 페이지는 페이지 내용이나 시작 커서를 저장해
                구현할 수 있습니다. 페이지 번호와 offset은 제공하지 않지만, 전체
                개수는 <code>count()</code>로 서버에서 셀 수 있습니다. 모든
                문서를 훑어야 한다면 <code>all()</code>이 커서를 대신
                관리합니다. 페이지 이동은 하나의 스냅샷이 아니므로, 새 문서는
                새로고침해야 보일 수 있고 정렬 기준 값이 바뀐 문서는 이동 중
                빠지거나 다시 나타날 수 있습니다.
              </p>
              <p>
                <code>created_at</code>은 처음 저장할 때 서버가 정하고
                덮어쓰기에도 유지됩니다. <code>updated_at</code>은 저장할 때
                갱신됩니다. 기존 문서는 생성 시각을 기록하지 않았으므로
                마이그레이션 당시의 수정 시각으로 채워집니다. JSON에 같은 이름의
                필드를 넣어도 서버 시각을 변경할 수 없습니다.
              </p>
              <Code>{`// 커서를 직접 다루지 않고 전부 순회합니다.
for await (const document of db.collection("posts").all({
  where: { categoryId: "diary" },
  orderBy: "data.date",
  direction: "desc",
})) {
  console.log(document.id, document.data);
}

// 개수는 서버가 셉니다.
const total = await db.collection("posts").count({
  where: { categoryId: "diary" },
});`}</Code>
              <h3 id="versions" className="font-bold">
                부분 갱신과 덮어쓰기 방지
              </h3>
              <p>
                <code>set()</code>은 기존 필드를 합치지 않고 전체 JSON을
                교체합니다. 일부 필드만 바꾸려면 <code>update()</code>를
                사용하세요. 최상위 필드를 병합하고, <code>unset</code>에 적은
                필드는 지웁니다. 값으로 넘긴 <code>null</code>은 필드를 지우지
                않고 null을 저장하므로, 삭제는 항상 <code>unset</code>으로만
                일어납니다. 대상 문서가 없거나 JSON 객체가 아니면 실패합니다.
              </p>
              <p>
                모든 문서에는 저장할 때마다 1씩 오르는 <code>version</code>이
                있습니다. 읽어 온 <code>version</code>을 <code>ifVersion</code>
                으로 함께 보내면, 그 사이 다른 곳에서 저장된 문서는 덮어쓰지
                않고 <code>VERSION_CONFLICT</code> 코드와 함께 409로 거절합니다.
                <code>ifVersion: 0</code>은 &ldquo;아직 없는 문서&rdquo;를
                뜻하므로 새 글을 만들 때 같은 ID를 덮어쓰는 사고를 막습니다.
              </p>
              <Code>{`const post = await db.collection("posts").get("hello");
try {
  await owner.collection("posts").update(
    "hello",
    { title: "새 제목" },
    { unset: ["legacy"], ifVersion: post.version },
  );
} catch (error) {
  if (error.code === "VERSION_CONFLICT")
    alert("다른 곳에서 먼저 저장했습니다. 새로고침 후 다시 시도하세요.");
  else throw error;
}`}</Code>
              <p>
                실시간 구독은 제공하지 않습니다. 공개 생성 전용 컬렉션에서는{" "}
                <code>set()</code>으로 새 ID를 만드는 것도 금지됩니다.
              </p>
            </Section>
            <Section id="owner" title="04 · 웹사이트에서 관리자 로그인">
              <p>
                정적 웹사이트에서도 관리자 글쓰기를 할 수 있습니다. 사이트에
                비밀번호나 장기 API 키를 넣지 않습니다. 사용자가 나루에서
                로그인하고 승인하면 웹사이트가 최대 24시간의 관리자 세션을
                받습니다.
              </p>
              <ol className="list-decimal space-y-3 pl-6">
                <li>
                  제어판의 ‘웹사이트 관리자 로그인’에서 정확한 콜백 URL을
                  등록합니다. 예:{" "}
                  <code>https://내사이트.naru.pub/admin.html</code>.
                </li>
                <li>
                  접근할 컬렉션을 선택합니다. 이 예제는 <code>posts</code>와{" "}
                  <code>drafts</code>를 선택합니다. SDK는 등록된 정확한 콜백
                  URL로 공개 Client ID를 자동 확인합니다. 각 페이지의 URL과
                  컬렉션 권한은 따로 등록하고 수정할 수 있습니다.
                </li>
                <li>
                  로그인 버튼에서 <code>signInAsOwner()</code>를 호출합니다.
                  현재 페이지를 떠나 나루 승인 화면으로 이동합니다.
                </li>
                <li>
                  돌아온 페이지에서 <code>completeOwnerSignIn()</code>을
                  호출하고, 반환받은 관리자 클라이언트로 문서를 저장합니다.
                </li>
              </ol>
              <Code>{`import { createDatabase } from "https://naru.pub/sdk/1.0.0/naru-data.js";\nconst db = createDatabase({ site: "내-로그인-이름" });\nlet owner = null;\ntry {\n  owner = await db.completeOwnerSignIn();\n} catch (error) {\n  document.querySelector("#status").textContent = error.message;\n}\n\nasync function login() {\n  await db.signInAsOwner({\n    redirectUri: location.origin + location.pathname,\n    collections: ["posts", "drafts"],\n  });\n}\n\nasync function publish(id, title, body) {\n  if (!owner) throw new Error("관리자 로그인이 필요합니다.");\n  await owner.collection("posts").set(id, { title, body });\n}\n\nasync function logout() {\n  const previous = owner;\n  owner = null;\n  await previous?.signOut();\n}`}</Code>
              <p>
                콜백은 본인 나루 사이트 또는 활성화된 인증 도메인의 HTTPS
                주소여야 합니다. 쿼리·해시·와일드카드는 사용할 수 없습니다.
                파일명과 경로를 정확히 맞추세요. SDK를 호출하는 페이지와 콜백의
                origin도 같아야 합니다.
              </p>
              <p>
                관리자 클라이언트는 기존 공개 클라이언트 <code>db</code>와
                별개입니다. 관리자 토큰 하나를 이 탭의 sessionStorage에 저장하여
                같은 관리자 페이지를 새로고침해도 복원합니다. 자동 갱신은 없으며
                새로고침하거나 요청해도 만료 시각은 늘어나지 않습니다. 서버는 매
                요청마다 권한과 폐기 여부를 확인합니다.
                <code>owner.expiresAt</code>은 최대 24시간인 관리자 토큰의 만료
                시각입니다(Unix 밀리초). 나루 로그인 세션이 먼저 만료되면 관리자
                세션도 종료됩니다.
              </p>
              <p>
                제어판에서 관리자 페이지마다 ‘관리자 토큰 유효 시간’을
                1–1,440분으로 설정할 수 있습니다(기본 24시간). 승인 화면에
                표시된 시간과 나루 로그인 세션의 남은 시간 중 짧은 쪽이
                적용됩니다. 시간을 줄이면 해당 페이지의 기존 토큰과 승인 코드를
                취소합니다. 시간만 늘리면 다음 로그인부터 적용되며 기존 토큰의
                만료 시각은 바뀌지 않습니다. SDK에서는 이 제한을 늘릴 수
                없습니다.
              </p>
              <p>
                Client ID를 코드에 복사할 필요가 없습니다. 등록되지 않은 정확한
                URL에서는 <code>UNREGISTERED_REDIRECT_URI</code> 오류가
                반환됩니다. 관리자 토큰은 비밀이므로 외부 스크립트를 넣거나
                복사·공유하지 마세요. 같은 출처의 다른 경로는 보안 격리 경계가
                아닙니다. 브라우저가 탭 상태를 복원할 수 있으므로 명시적인
                로그아웃으로 세션을 종료하세요.
              </p>
              <p>
                <code>signOut()</code>은 이 관리자 토큰을 폐기합니다. 나루
                계정의 로그아웃과는 별개입니다. 제어판에서 등록의 전체 토큰 폐기
                또는 등록 삭제도 가능합니다. 서버 폐기 요청이 실패해도 로컬
                토큰은 제거되지만, 서버의 권한은 폐기되거나 만료될 때까지 남을
                수 있습니다.
              </p>
              <p>
                편집 페이지의 외부 스크립트는 관리자 권한을 악용할 수 있습니다.
                신뢰할 수 있는 코드만 실행하세요. 문서 접근 권한으로 컬렉션
                설정이나 계정 정보를 변경할 수는 없습니다.
              </p>
              <h3 className="text-lg font-semibold">파일과 이미지 업로드</h3>
              <p>
                관리자 클라이언트의 <code>owner.files.upload(file)</code>은
                브라우저에서 Naru Media로 파일을 직접 올리고, 확인된 공개 URL과
                파일 ID를 반환합니다. 문서에는 base64 대신 이 URL이나 ID를
                저장하세요. 파일 하나는 25 MiB, 사이트당 1,000개·250 MiB까지
                저장할 수 있습니다. HTML과 SVG는 허용하지 않습니다.
              </p>
              <Code>{`const image = await owner.files.upload(fileInput.files[0], {
  signal: abortController.signal,
  onProgress: ({ loaded, total }) => showProgress(loaded / total),
  metadata: { altText: "설명", references: [{ collection: "posts", id: "hello" }] },
});
await owner.collection("posts").set("hello", {
  title: "안녕하세요",
  coverImage: image.url,
});

// metadata는 목록에도 함께 돌아오므로, 어떤 글의 이미지인지 되짚어
// 글을 지울 때 남은 파일을 함께 정리할 수 있습니다.
const files = await owner.files.list();
const mine = files.filter((file) =>
  file.metadata?.references?.some((reference) => reference.id === "hello"),
);
for (const file of mine) await owner.files.delete(file.id);

const { bytes, maxBytes, count, maxFiles } = await owner.files.usage();`}</Code>
              <p>
                <code>metadata</code>에 넣은 값은 <code>files.list()</code>와{" "}
                <code>files.get()</code>에 그대로 돌아옵니다. 어떤 문서가 그
                파일을 쓰는지 적어 두면, 문서를 삭제할 때 딸린 파일도 함께 지워
                저장 용량이 새는 것을 막을 수 있습니다.{" "}
                <code>files.usage()</code>는 현재 사용량과 한도를 알려줍니다.
              </p>
              <h3 className="text-lg font-semibold">원자적 batch와 검증</h3>
              <p>
                <code>owner.batch()</code>는 최대 100개의 문서 저장·병합·삭제를
                한 트랜잭션으로 처리합니다. 하나라도 실패하면 모두 취소되므로,
                <code>ifVersion</code>이 어긋난 항목 하나가 앞선 저장까지 함께
                되돌립니다.
                <code>createDatabase()</code>의 <code>schemas</code>에는 요청 전
                실행할 동기 검증 함수를 지정할 수 있습니다. 클라이언트 검증은
                개발 편의 기능이며 보안 경계가 아닙니다.
              </p>
              <Code>{`const db = createDatabase({
  site: "내-로그인-이름",
  schemas: {
    posts: (post) => typeof post?.title === "string" && post.title.length > 0,
  },
});

await owner.batch([
  { type: "set", collection: "posts", id, data: post, ifVersion: 0 },
  { type: "add", collection: "logs", data: { published: id } },
  { type: "update", collection: "stats", id: "totals", data: { posts: 12 } },
  { type: "delete", collection: "drafts", id },
]);`}</Code>
              <p>
                <code>add</code>는 서버가 ID를 정하므로 <code>id</code>나{" "}
                <code>ifVersion</code>을 함께 보낼 수 없습니다. 정해진 ID가
                필요하면 <code>set</code>을 쓰세요. 결과 배열은 보낸 순서대로 각
                항목의 <code>id</code>와 <code>version</code>을 돌려줍니다.
              </p>
              <p>
                SDK 오류의 <code>code</code>에는
                <code>UNREGISTERED_REDIRECT_URI</code>,
                <code>COLLECTION_NOT_AUTHORIZED</code>,
                <code>VERSION_CONFLICT</code>,<code>OWNER_SESSION_EXPIRED</code>
                처럼 처리 가능한 안정적인 값이 들어갑니다. 로컬 개발에서는{" "}
                <code>controlPlaneOrigin</code>에 HTTP localhost 또는 loopback
                주소만 지정할 수 있습니다.
              </p>
            </Section>
            <Section id="example" title="05 · 예제 블로그 설치">
              <p>
                ‘작은 기록’은 분류별 글 목록·글 상세·방명록·관리자 편집·비공개
                초안을 갖춘 정적 웹사이트입니다. 프레임워크나 빌드 과정 없이
                사용할 수 있습니다.
              </p>
              <p>
                <a href="/database/docs/blog.zip">예제 ZIP 내려받기</a> ·{" "}
                <a href="/examples/database-blog/index.html">
                  설정 전 예제 화면 보기
                </a>
              </p>
              <ol className="list-decimal space-y-3 pl-6">
                <li>
                  ZIP을 풀고 제어판에서 위 표처럼 <code>posts</code>와{" "}
                  <code>guestbook</code>, <code>drafts</code> 컬렉션을 만듭니다.
                </li>
                <li>
                  업로드할 주소를 정합니다. 루트라면 콜백은{" "}
                  <code>https://내사이트.naru.pub/admin.html</code>, blog
                  폴더라면{" "}
                  <code>https://내사이트.naru.pub/blog/admin.html</code>입니다.
                </li>
                <li>
                  ‘웹사이트 관리자 로그인’에 이 콜백과 <code>posts</code>·
                  <code>drafts</code> 컬렉션을 등록합니다.
                </li>
                <li>
                  <code>config.js</code>의 <code>site</code>를 채웁니다.
                </li>
                <li>
                  파일을 모두 같은 폴더에 업로드합니다. 기존{" "}
                  <code>index.html</code>을 덮어쓰지 않도록 새 폴더를 사용하는
                  것이 안전합니다.
                </li>
                <li>
                  호스팅된 <code>index.html</code>을 열고 글쓰기 → 나루로 관리자
                  로그인 → 승인 → 글 공개하기를 진행합니다. 로그아웃 상태에서
                  글을 읽고 방명록도 남겨 보세요.
                </li>
              </ol>
              <Code>{`export const config = {\n  site: "내-로그인-이름",\n};`}</Code>
              <p>
                파일을 직접 더블클릭한 <code>file://</code> 주소에서는 실행하지
                마세요. 나루의 HTTPS 주소에서 확인하세요. 제공되는 미리보기에는
                사용자 데이터베이스가 연결되어 있지 않습니다.
              </p>
              <p>
                이 예제의 본문은 일반 텍스트입니다. 글쓰기 화면에서 목록
                불러오기를 누르고 공개 글이나 비공개 초안을 선택해 편집·삭제할
                수 있습니다. 새 글 작성은 별도 ID로 시작합니다. 방명록 관리는
                제어판에서 합니다. 입력 길이 제한은 화면의 편의 기능이며 서버
                검증 규칙이 아닙니다.
              </p>
              <p>
                기존 예제를 업그레이드한다면 관리자 읽기·쓰기의{" "}
                <code>drafts</code> 컬렉션을 먼저 만드세요. 기존 웹사이트 등록의
                수정 버튼으로 posts와 drafts를 선택하세요. Client ID를 바꿀
                필요가 없습니다. 수정하면 해당 페이지의 기존 로그인 권한이
                취소되므로 다시 로그인하세요.
              </p>
              <p>
                작성 중인 내용은 로그인 이동을 위해 이 탭의 sessionStorage에
                임시 저장됩니다. ‘비공개 초안 저장’은 drafts에 서버 저장하며,
                같은 ID의 공개 글은 바꾸지 않습니다. ‘글 공개하기’는 posts에
                먼저 저장한 뒤 해당 초안을 삭제합니다. 두 요청은 하나의
                트랜잭션이 아니므로, 공개는 성공했지만 초안 삭제가 실패하면
                안내에 따라 재시도하거나 초안 목록에서 정리하세요.
              </p>
              <p>
                분류를 입력해 공개하면 글 목록에서 같은 분류로 찾을 수 있습니다.
                편집은 전체 문서를 덮어쓰므로 여러 탭의 동시 편집에서는 마지막
                저장이 우선합니다. 삭제는 확인 후 선택한 컬렉션의 문서만 영구
                삭제합니다. 공용 기기에서는 관리자 권한을 해제하고 탭을
                닫으세요.
              </p>
            </Section>
            <Section id="limits" title="06 · 한도와 문제 해결">
              <ul className="list-disc space-y-3 pl-6">
                <li>
                  사이트당 컬렉션 100개, 문서 10,000개, JSON 데이터 10 MiB까지
                  저장합니다. 요청 본문은 JSON 포장을 포함해 64 KiB 이하입니다.
                </li>
                <li>
                  공개 생성 요청은 분당 사이트 60회, 호출자 IP별 사이트 20회로
                  제한됩니다. 신뢰할 수 있는 IP 정보가 없으면 호출자 한도를
                  공유합니다. 대량 스팸에 대한 별도 운영 대책은 필요합니다.
                </li>
                <li>
                  웹사이트 등록은 사이트당 최대 20개입니다. 최소한의 컬렉션만
                  선택하세요.
                </li>
              </ul>
              <Code>{`try {\n  await db.collection("guestbook").add({ message: "안녕하세요" });\n} catch (error) {\n  // NaruDataError.status는 HTTP 상태이며, 응답을 받지 못하면 0입니다.\n  // 잘못된 입력은 TypeError입니다.\n  document.querySelector("#status").textContent =\n    error.status === 429 ? "잠시 후 다시 시도하세요." : error.message;\n}`}</Code>
              <p>
                네트워크 오류가 나도 쓰기는 서버에 저장되었을 수 있습니다. SDK는
                자동 재시도하지 않습니다. 특히 add()를 다시 호출하면 중복 문서가
                생길 수 있으므로 먼저 저장 여부를 확인하세요.
              </p>
              <p>
                데이터에는 JSON 값만 사용하세요. undefined, NaN, Infinity,
                BigInt, 함수, 순환 참조, 빈 배열 슬롯은 허용하지 않습니다.
                Date는 문자열로 명시적으로 변환하세요. 객체는 일반 객체여야 하며
                getter, Symbol 키, 열거할 수 없는 속성도 허용하지 않습니다.
              </p>
              <p>
                TypeScript에서는 collection&lt;Post&gt;(&quot;posts&quot;)로
                읽기와 쓰기 타입을 지정할 수 있습니다. 이 타입은 서버 데이터의
                런타임 검증을 대신하지 않습니다.
              </p>
              <dl className="space-y-4">
                {[
                  [
                    "401 · 인증 실패",
                    "관리자 권한이 만료되었거나 폐기되었습니다. 다시 로그인하세요. 오류가 나도 공개 권한으로 자동 전환하지 않습니다.",
                  ],
                  [
                    "403 · 권한 없음",
                    "읽기·쓰기 설정, 등록된 컬렉션, 콜백 주소와 도메인 인증 상태를 확인하세요. 공개 생성 전용에서는 set/delete가 금지됩니다.",
                  ],
                  [
                    "404 · 찾을 수 없음",
                    "site가 로그인 이름인지, 컬렉션 이름과 문서 ID가 맞는지 확인하세요.",
                  ],
                  [
                    "409 / 413 / 429",
                    "각각 충돌, 요청 크기 초과, 요청 빈도 초과를 뜻합니다. 409의 code로 원인을 구분하세요. VERSION_CONFLICT는 ifVersion과 저장된 버전이 다른 경우, NOT_MERGEABLE은 JSON 객체가 아닌 문서를 update()로 병합하려 한 경우이며, code가 없으면 용량·개수 한도 초과입니다.",
                  ],
                  [
                    "승인 후 돌아왔는데 로그인되지 않음",
                    "같은 브라우저 탭에서 승인하고 sessionStorage를 허용하세요. 콜백은 즉시 처리해야 합니다. 승인 코드는 60초 동안 한 번만 사용할 수 있습니다.",
                  ],
                  [
                    "저장 응답이 끊김",
                    "저장은 성공했을 수도 있습니다. 공개 add를 무조건 재시도하면 중복이 생길 수 있습니다. 예제의 관리자 글쓰기는 초안별 고정 ID와 set을 사용합니다.",
                  ],
                ].map(([title, body]) => (
                  <div key={title}>
                    <dt className="font-bold">{title}</dt>
                    <dd className="text-muted-foreground">{body}</dd>
                  </div>
                ))}
              </dl>
            </Section>
          </article>
        </div>
      </div>
    </div>
  );
}
