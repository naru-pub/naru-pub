import { connect } from "./client.js";
import { $, message, errorMessage, element, text, date } from "./utils.js";
const guestbook = document.body.dataset.page === "guestbook";
let db, cursor;
async function load(reset = false) {
  $("more").disabled = true;
  try {
    db ??= await connect();
    const page = await db
      .collection(guestbook ? "guestbook" : "posts")
      .list({ limit: 20, ...(reset ? {} : cursor ? { after: cursor } : {}) });
    if (reset) $("entries").replaceChildren();
    for (const doc of page.documents) {
      const data = doc.data && typeof doc.data === "object" ? doc.data : {};
      const card = element("article", "", "card");
      if (guestbook) {
        card.append(
          element("h2", text(data.name, "방문자")),
          element("p", text(data.message), "body"),
        );
      } else {
        const link = element("a", text(data.title, "제목 없음"));
        link.href = `./post.html?id=${encodeURIComponent(doc.id)}`;
        const heading = element("h2", "");
        heading.append(link);
        card.append(
          heading,
          element("p", text(data.body).slice(0, 160), "excerpt"),
        );
      }
      card.append(element("p", date(data.createdAt), "meta"));
      $("entries").append(card);
    }
    cursor = page.nextCursor;
    $("more").hidden = !cursor;
    message(
      $("entries").children.length
        ? ""
        : guestbook
          ? "첫 인사를 남겨 주세요."
          : "아직 글이 없습니다. 글쓰기에서 첫 글을 작성하세요.",
    );
    return true;
  } catch (e) {
    message(errorMessage(e));
    return false;
  } finally {
    $("more").disabled = false;
  }
}
$("more").addEventListener("click", () => load());
if (guestbook)
  $("entry-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const name = $("name").value.trim(),
      body = $("message").value.trim();
    if (!name || !body) return message("이름과 내용을 입력하세요.");
    $("submit").disabled = true;
    try {
      db ??= await connect();
      await db
        .collection("guestbook")
        .add({ name, message: body, createdAt: new Date().toISOString() });
      $("entry-form").reset();
      const refreshed = await load(true);
      message(
        refreshed
          ? "인사를 남겼습니다. 목록은 문서 ID 순서입니다."
          : "인사는 저장되었지만 목록을 불러오지 못했습니다. 다시 제출하지 말고 페이지를 새로고침하세요.",
      );
    } catch (e) {
      message(
        `${errorMessage(e)} 응답이 끊겼다면 이미 저장되었을 수 있으니 목록을 확인한 후 다시 제출하세요.`,
      );
    } finally {
      $("submit").disabled = false;
    }
  });
await load(true);
