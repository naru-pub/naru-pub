import { config } from "./config.js";
import { connect } from "./client.js";
import { $, message, errorMessage, element, text, date } from "./utils.js";
import { publishPost } from "./editor.js";
let db,
  owner = null,
  busy = false,
  cursor,
  listKind = "posts";
let state = { id: null, kind: null, hasDraft: false, extra: {} };
let dirty = false;
const draftKey = `naru:blog-draft:${config.site}:${location.pathname}`;
function data() {
  return {
    ...state.extra,
    title: $("title").value.trim(),
    body: $("body").value.trim(),
    category: $("category").value.trim(),
  };
}
function saveLocal() {
  state.id ??= crypto.randomUUID();
  sessionStorage.setItem(
    draftKey,
    JSON.stringify({
      ...state,
      title: $("title").value,
      body: $("body").value,
      category: $("category").value,
    }),
  );
}
function updateUI() {
  for (const id of [
    "publish",
    "save-draft",
    "reload-list",
    "manage-kind",
    "manage-more",
  ])
    $(id).disabled = busy || !owner;
  $("delete-post").disabled = busy || !owner || !state.kind;
  $("new-post").disabled = busy;
  $("login").hidden = !!owner;
  $("login").disabled = busy;
  $("logout").hidden = !owner;
  $("logout").disabled = busy;
  for (const id of ["title", "body", "category"]) $(id).readOnly = busy;
  $("manage-list").disabled = busy || !owner;
  $("auth").textContent = owner
    ? `관리자 로그인됨 · ${new Date(owner.expiresAt).toLocaleTimeString("ko-KR")}까지`
    : "글을 관리하려면 사이트 소유자로 로그인하세요.";
  $("editing").textContent =
    state.kind === "posts"
      ? `공개 글 편집 · ${state.id}`
      : state.kind === "drafts"
        ? `비공개 초안 편집 · ${state.id}`
        : "새 글 작성";
  $("publish").textContent =
    state.kind === "posts" ? "공개 글 저장" : "글 공개하기";
  $("delete-post").textContent =
    state.kind === "drafts" ? "이 초안 삭제" : "이 공개 글 삭제";
  if (!owner) {
    $("manage-list").replaceChildren();
    $("manage-more").hidden = true;
  }
}
async function run(action) {
  if (busy) return;
  busy = true;
  updateUI();
  try {
    await action();
  } catch (e) {
    if (e.status === 401) owner = null;
    message(errorMessage(e));
  } finally {
    busy = false;
    updateUI();
  }
}
function canLeave() {
  return !dirty || window.confirm("저장하지 않은 변경 사항을 버릴까요?");
}
function clearEditor() {
  state = { id: null, kind: null, hasDraft: false, extra: {} };
  $("post-form").reset();
  dirty = false;
  sessionStorage.removeItem(draftKey);
  $("view-post").hidden = true;
}
async function loadList(reset = true) {
  if (!owner) return;
  const kind = $("manage-kind").value;
  if (reset || kind !== listKind) {
    cursor = undefined;
    $("manage-list").replaceChildren();
  }
  listKind = kind;
  const page = await owner
    .collection(kind)
    .list({
      limit: 20,
      orderBy: "updated_at",
      direction: "desc",
      ...(cursor ? { after: cursor } : {}),
    });
  for (const doc of page.documents) {
    const row = element("div", "", "manage-row");
    const button = element("button", text(doc.data?.title, "제목 없음"));
    button.type = "button";
    button.id = `edit-${kind}-${doc.id}`;
    button.addEventListener("click", () =>
      run(async () => {
        if (!canLeave()) return;
        const latest = await owner.collection(kind).get(doc.id);
        const content =
          latest.data &&
          typeof latest.data === "object" &&
          !Array.isArray(latest.data)
            ? latest.data
            : {};
        state = {
          id: latest.id,
          kind,
          hasDraft: kind === "drafts",
          extra: content,
        };
        $("title").value = text(content.title);
        $("body").value = text(content.body);
        $("category").value = text(content.category);
        dirty = false;
        saveLocal();
        $("view-post").hidden = kind !== "posts";
        $("view-post").href = `./post.html?id=${encodeURIComponent(latest.id)}`;
        message(
          "글을 불러왔습니다. 저장하면 현재 서버 내용을 덮어씁니다. 여러 탭에서 동시에 편집하지 마세요.",
        );
      }),
    );
    row.append(button, element("span", date(doc.updated_at), "meta"));
    $("manage-list").append(row);
  }
  cursor = page.nextCursor;
  $("manage-more").hidden = !cursor;
  if (!$("manage-list").children.length)
    $("manage-list").append(element("p", "저장된 글이 없습니다.", "hint"));
}
async function refreshAfterWrite(notice) {
  try {
    await loadList(true);
    message(notice);
  } catch (e) {
    if (e.status === 401) owner = null;
    message(`${notice} 목록 갱신에 실패했습니다. ${errorMessage(e)}`);
  }
}
try {
  db = await connect();
  owner = await db.completeOwnerSignIn();
  message(
    owner ? "승인되었습니다. 공개 글과 비공개 초안을 관리할 수 있습니다." : "",
  );
} catch (e) {
  message(errorMessage(e));
}
try {
  const saved = JSON.parse(sessionStorage.getItem(draftKey) || "null");
  if (
    saved &&
    typeof saved.title === "string" &&
    typeof saved.body === "string"
  ) {
    state = {
      id:
        typeof saved.id === "string" && /^[a-zA-Z0-9_-]{1,64}$/.test(saved.id)
          ? saved.id
          : null,
      kind: ["posts", "drafts"].includes(saved.kind) ? saved.kind : null,
      hasDraft: saved.hasDraft === true,
      extra:
        saved.extra &&
        typeof saved.extra === "object" &&
        !Array.isArray(saved.extra)
          ? saved.extra
          : {},
    };
    $("title").value = saved.title;
    $("body").value = saved.body;
    $("category").value = text(saved.category);
    dirty = true;
  }
} catch {
  message(
    "임시 저장된 초안을 읽을 수 없습니다. 새 글을 작성하거나 저장소 설정을 확인하세요.",
  );
}
updateUI();
$("login").addEventListener("click", () =>
  run(async () => {
    if (!config.clientId)
      throw new Error("config.js에 제어판에서 발급받은 clientId를 입력하세요.");
    saveLocal();
    db ??= await connect();
    await db.signInAsOwner({
      clientId: config.clientId,
      redirectUri: location.origin + location.pathname,
      collections: ["posts", "drafts"],
    });
  }),
);
$("logout").addEventListener("click", () =>
  run(async () => {
    if (!canLeave()) return;
    const previous = owner;
    owner = null;
    clearEditor();
    updateUI();
    try {
      await previous?.signOut();
      message("관리자 권한과 이 탭의 임시 저장을 해제했습니다.");
    } catch (e) {
      message(
        `로컬 권한은 해제되었습니다. 서버 해제에 실패했습니다. 제어판에서 토큰을 폐기하거나 만료를 기다리세요. ${errorMessage(e)}`,
      );
    }
  }),
);
$("post-form").addEventListener("input", () => {
  dirty = true;
  try {
    saveLocal();
  } catch {
    message(
      "임시 저장을 사용할 수 없습니다. 페이지를 떠나기 전에 글을 복사하세요.",
    );
  }
});
$("new-post").addEventListener("click", () =>
  run(async () => {
    if (canLeave()) {
      clearEditor();
      message("새 글을 작성하세요.");
    }
  }),
);
$("save-draft").addEventListener("click", () =>
  run(async () => {
    if (!owner) throw new Error("관리자 로그인이 필요합니다.");
    if (!$("title").value.trim()) throw new Error("초안 제목을 입력하세요.");
    saveLocal();
    await owner.collection("drafts").set(state.id, data());
    state.kind = "drafts";
    state.hasDraft = true;
    dirty = false;
    saveLocal();
    await refreshAfterWrite(
      "비공개 초안을 저장했습니다. 같은 ID의 공개 글이 있다면 그대로 유지됩니다.",
    );
  }),
);
$("post-form").addEventListener("submit", (event) => {
  event.preventDefault();
  return run(async () => {
    if (!owner) throw new Error("관리자 로그인이 필요합니다.");
    if (!$("title").value.trim() || !$("body").value.trim())
      throw new Error("제목과 본문을 입력하세요.");
    saveLocal();
    const result = await publishPost(owner, state.id, data(), state.hasDraft);
    state.kind = "posts";
    state.hasDraft = !!result.cleanupError;
    dirty = false;
    saveLocal();
    $("view-post").href = `./post.html?id=${encodeURIComponent(state.id)}`;
    $("view-post").hidden = false;
    if (result.cleanupError?.status === 401) owner = null;
    await refreshAfterWrite(
      result.cleanupError
        ? `글은 공개되었지만 비공개 초안 삭제에 실패했습니다. 같은 글을 다시 저장해 정리를 재시도하거나 초안 목록에서 삭제하세요. ${errorMessage(result.cleanupError)}`
        : "공개 글을 저장했습니다. 계속 편집하거나 새 글을 작성할 수 있습니다.",
    );
  });
});
$("delete-post").addEventListener("click", () =>
  run(async () => {
    if (!owner || !state.kind) return;
    const label = state.kind === "drafts" ? "비공개 초안" : "공개 글";
    if (
      !window.confirm(
        `${label} '${$("title").value}'을 영구 삭제할까요? 되돌릴 수 없습니다.`,
      )
    )
      return;
    await owner.collection(state.kind).delete(state.id);
    clearEditor();
    await refreshAfterWrite(
      `${label}을 삭제했습니다. 다른 컬렉션의 같은 ID 문서는 그대로 유지됩니다.`,
    );
  }),
);
$("reload-list").addEventListener("click", () => run(() => loadList(true)));
$("manage-kind").addEventListener("change", () => run(() => loadList(true)));
$("manage-more").addEventListener("click", () => run(() => loadList(false)));
// Explicit loading also lets the editor recover its local draft when the network is unavailable.
