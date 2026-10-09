// A post's title, or a quiet 제목 없음 when it has none worth showing. A
// title of only punctuation (".", "-") reads as a rendering glitch on a card.
export function isUntitled(title: string): boolean {
  return !/[\p{L}\p{N}]/u.test(title);
}

export function PostTitle({ title }: { title: string }) {
  return isUntitled(title) ? (
    <span className="font-medium italic text-muted-foreground">제목 없음</span>
  ) : (
    <>{title}</>
  );
}
