export function formatDate(value: Date | string | null) {
  if (!value) return "-";
  return new Intl.DateTimeFormat("ko-KR", {
    dateStyle: "short",
    timeStyle: "short",
    timeZone: "Asia/Seoul",
  }).format(new Date(value));
}

export function formatKrw(amount: number) {
  return new Intl.NumberFormat("ko-KR").format(amount) + "원";
}
