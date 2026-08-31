export const $ = (id) => document.getElementById(id);
export function message(text) {
  $("status").textContent = text;
}
export function errorMessage(error) {
  const hints = {
    401: "관리자 권한이 만료되었거나 유효하지 않습니다. 다시 로그인하세요.",
    403: "컬렉션 권한과 웹사이트 등록 범위를 확인하세요.",
    404: "글이 없거나 컬렉션이 아직 만들어지지 않았습니다.",
    409: "저장 용량 또는 문서 개수 한도를 확인하세요.",
    429: "요청이 많습니다. 잠시 후 다시 시도하세요.",
  };
  return hints[error.status] || error.message || "요청에 실패했습니다.";
}
export function text(value, fallback = "") {
  return typeof value === "string" ? value : fallback;
}
export function element(tag, content, className) {
  const node = document.createElement(tag);
  node.textContent = content;
  if (className) node.className = className;
  return node;
}
export function date(value) {
  const d = new Date(value);
  return typeof value === "string" && Number.isFinite(d.getTime())
    ? d.toLocaleDateString("ko-KR")
    : "날짜 없음";
}
