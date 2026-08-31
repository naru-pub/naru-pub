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
                        "문서 한 개 → { id, data, created_at, updated_at }. 없으면 404",
                      ],
                      [
                        "list({ limit, after, orderBy, direction, where })",
                        "{ documents, nextCursor }. 기본 50개, 최대 100개",
                      ],
                      ["add(data)", "서버 ID로 새 문서 생성 → { id }"],
                      [
                        "set(id, data)",
                        "지정 ID로 생성 또는 전체 교체 → { id }",
                      ],
                      ["delete(id)", "문서 삭제 → { success: true }"],
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
                <code>"1"</code>은 다릅니다. 문자열은 대소문자를 포함해 정확히
                비교하며 <code>null</code>은 실제 null 필드만 찾습니다. 필드가
                없는 문서는 일치하지 않습니다.
              </p>
              <p>
                중첩 경로·배열 검색·범위 비교·OR·부분 문자열 검색은 아직
                지원하지 않습니다. 빈 <code>where: {"{}"}</code> 또는 where
                생략은 전체 목록을 뜻합니다. 필터 값은 URL에 들어가므로 비밀번호
                같은 비밀을 넣지 마세요.
              </p>
              <p>
                나루가 JSON 필터용 GIN 인덱스와 생성·수정 시각 정렬용 인덱스를
                자동으로 유지합니다. 필드별 인덱스를 직접 생성할 필요가 없으며,
                문서 저장·수정·삭제 시 함께 갱신됩니다. 정렬은 서버 메타데이터만
                지원합니다.
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
                <code>updated_at</code>(서버 수정 시각) 중 하나이며,{" "}
                <code>direction</code>은 <code>asc</code>(기본값) 또는{" "}
                <code>desc</code>입니다. 블로그와 방명록은{" "}
                <code>created_at</code> 내림차순으로 최신 글부터 표시합니다.
                JSON 내부 필드(예: <code>data.createdAt</code>) 정렬은 지원하지
                않습니다.
              </p>
              <p>
                동일한 시각의 문서는 같은 방향의 ID 순서로 정렬합니다. 다음
                페이지에는 응답의 <code>nextCursor</code>를 그대로{" "}
                <code>after</code>로 보내고, 같은 컬렉션·정렬 필드·방향·필터를
                유지하세요. 커서를 직접 해석하거나 만들지 마세요. 다른 정렬이나
                필터에 사용하면 400 오류가 발생합니다. 정렬이나 필터를 바꾸려면
                커서와 기존 목록을 비우고 첫 페이지부터 다시 불러오세요.
              </p>
              <p>
                <code>nextCursor</code>가 <code>null</code>이면 마지막
                페이지입니다. 이전 페이지는 페이지 내용이나 시작 커서를 저장해
                구현할 수 있습니다. 페이지 번호·offset·전체 개수는 제공하지
                않습니다. 페이지 이동은 하나의 스냅샷이 아니므로, 새 문서는
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
              <p>
                실시간 구독·부분 필드 갱신은 제공하지 않습니다.{" "}
                <code>set()</code>은 기존 필드를 합치지 않고 전체 JSON을
                교체합니다. 공개 생성 전용에서는 <code>set()</code>으로 새 ID를
                만드는 것도 금지됩니다.
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
                  <code>drafts</code>를 선택합니다. 표시된 Client ID를
                  복사합니다. Client ID는 웹사이트마다 고정된 공개 식별자입니다.
                  여러 관리자 페이지에서 같은 ID를 사용합니다. 각 페이지의 URL과
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
              <Code>{`import { createDatabase } from "https://naru.pub/sdk/1.0.0/naru-data.js";\nconst db = createDatabase({ site: "내-로그인-이름" });\nlet owner = null;\ntry {\n  // Complete approval or restore this tab; null means signed out.\n  owner = await db.completeOwnerSignIn();\n} catch (error) {\n  document.querySelector("#status").textContent = error.message;\n}\n\n// 로그인 버튼의 클릭 핸들러에서 호출하세요.\nasync function login() {\n  await db.signInAsOwner({\n    clientId: "제어판의-Client-ID",\n    redirectUri: location.origin + location.pathname,\n    collections: ["posts", "drafts"],\n  });\n}\n\n// 저장 버튼 핸들러에서 호출하고 오류를 표시하세요.\nasync function publish(id, title, body) {\n  if (!owner) throw new Error("관리자 로그인이 필요합니다.");\n  await owner.collection("posts").set(id, { title, body });\n}\n\nasync function logout() {\n  const previous = owner;\n  owner = null;\n  await previous?.signOut();\n}`}</Code>
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
                기존 페이지별 Client ID는 더 이상 사용할 수 없습니다. 모든
                관리자 페이지의 설정을 제어판의 웹사이트 공통 Client ID로 바꾸고
                다시 로그인하세요. 등록된 URL과 컬렉션 권한은 유지됩니다. 관리자
                토큰은 비밀이므로 외부 스크립트를 넣거나 복사·공유하지 마세요.
                같은 출처의 다른 경로는 보안 격리 경계가 아닙니다. 브라우저가 탭
                상태를 복원할 수 있으므로 명시적인 로그아웃으로 세션을
                종료하세요.
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
                  <code>drafts</code> 컬렉션을 등록하고 Client ID를 복사합니다.
                </li>
                <li>
                  <code>config.js</code>의 <code>site</code>와{" "}
                  <code>clientId</code>를 채웁니다.
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
              <Code>{`export const config = {\n  site: "내-로그인-이름",\n  clientId: "제어판에서-복사한-Client-ID",\n};`}</Code>
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
              <Code>{`try {\n  await db.collection("guestbook").add({ message: "안녕하세요" });\n} catch (error) {\n  // SDK API 오류는 NaruDataError이며 HTTP 상태가 status에 있습니다.\n  // 네트워크 오류는 status가 없을 수 있습니다.\n  document.querySelector("#status").textContent =\n    error.status === 429 ? "잠시 후 다시 시도하세요." : error.message;\n}`}</Code>
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
                    "각각 용량·개수 등의 충돌, 요청 크기 초과, 요청 빈도 초과를 뜻합니다.",
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
