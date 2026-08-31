import { connect } from "./client.js";
import { $, message, errorMessage, text, date } from "./utils.js";
try {
  const id = new URL(location.href).searchParams.get("id");
  if (!id)
    throw new Error("글 주소에 id가 없습니다. 글 목록에서 다시 선택하세요.");
  const db = await connect();
  const { data, created_at } = await db.collection("posts").get(id);
  $("title").textContent = text(data?.title, "제목 없음");
  $("body").textContent = text(data?.body);
  $("date").textContent = date(created_at);
  document.title = `${text(data?.title, "제목 없음")} · 작은 기록`;
  message("");
} catch (e) {
  message(errorMessage(e));
}
