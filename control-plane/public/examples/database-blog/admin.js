import { config } from "./config.js";
import { connect } from "./client.js";
import { $, message, errorMessage } from "./utils.js";
let db,
  owner = null,
  draftId,
  createdAt;
const draftKey = `naru:blog-draft:${config.site}:${location.pathname}`;
function saveDraft() {
  draftId ??= crypto.randomUUID();
  createdAt ??= new Date().toISOString();
  sessionStorage.setItem(
    draftKey,
    JSON.stringify({
      id: draftId,
      createdAt,
      title: $("title").value,
      body: $("body").value,
    }),
  );
}
function authState() {
  $("publish").disabled = !owner;
  $("logout").hidden = !owner;
  $("login").hidden = !!owner;
  $("auth").textContent = owner
    ? `관리자 로그인됨 · ${new Date(owner.expiresAt).toLocaleTimeString("ko-KR")}까지`
    : "글을 공개하려면 사이트 소유자로 로그인하세요.";
}
try {
  db = await connect();
  // 승인 콜백을 가장 먼저 처리합니다. 토큰은 이 페이지의 메모리에만 남습니다.
  owner = await db.completeOwnerSignIn();
  message(owner ? "승인되었습니다. 작성한 글을 공개할 수 있습니다." : "");
} catch (e) {
  message(errorMessage(e));
}
try {
  const draft = JSON.parse(sessionStorage.getItem(draftKey) || "null");
  if (
    draft &&
    typeof draft.title === "string" &&
    typeof draft.body === "string"
  ) {
    $("title").value = draft.title;
    $("body").value = draft.body;
    if (typeof draft.id === "string" && /^[a-zA-Z0-9_-]{1,64}$/.test(draft.id))
      draftId = draft.id;
    if (typeof draft.createdAt === "string") createdAt = draft.createdAt;
  }
} catch {
  message(
    "임시 저장된 초안을 읽을 수 없습니다. 새 글을 작성하거나 저장소 설정을 확인하세요.",
  );
}
authState();
$("login").addEventListener("click", async () => {
  $("login").disabled = true;
  try {
    if (!config.clientId)
      throw new Error("config.js에 제어판에서 발급받은 clientId를 입력하세요.");
    saveDraft();
    db ??= await connect();
    await db.signInAsOwner({
      clientId: config.clientId,
      redirectUri: location.origin + location.pathname,
      collections: ["posts"],
    });
  } catch (e) {
    message(errorMessage(e));
    $("login").disabled = false;
  }
});
$("logout").addEventListener("click", async () => {
  const previous = owner;
  owner = null;
  authState();
  try {
    await previous?.signOut();
    message("이 페이지의 관리자 권한을 해제했습니다.");
  } catch (e) {
    message(
      `로컬 권한은 해제되었습니다. 서버 해제에 실패했습니다. 제어판에서 토큰을 폐기하거나 만료를 기다리세요. ${errorMessage(e)}`,
    );
  }
});
$("post-form").addEventListener("input", () => {
  try {
    saveDraft();
  } catch {
    message(
      "임시 저장을 사용할 수 없습니다. 페이지를 떠나기 전에 글을 복사하세요.",
    );
  }
});
$("post-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!owner) return message("관리자 로그인이 필요합니다.");
  if (!$("title").value.trim() || !$("body").value.trim())
    return message("제목과 본문을 입력하세요.");
  $("publish").disabled = true;
  $("logout").disabled = true;
  $("title").readOnly = $("body").readOnly = true;
  try {
    saveDraft();
    // 같은 초안은 같은 ID를 사용하므로 응답 유실 후 재시도해도 글이 중복 생성되지 않습니다.
    await owner.collection("posts").set(draftId, {
      title: $("title").value.trim(),
      body: $("body").value.trim(),
      createdAt,
    });
    $("view-post").href = `./post.html?id=${encodeURIComponent(draftId)}`;
    $("view-post").hidden = false;
    $("post-form").reset();
    draftId = createdAt = undefined;
    sessionStorage.removeItem(draftKey);
    message("글을 공개했습니다.");
  } catch (e) {
    if (e.status === 401) owner = null;
    message(errorMessage(e));
  } finally {
    $("title").readOnly = $("body").readOnly = false;
    $("logout").disabled = false;
    authState();
  }
});
