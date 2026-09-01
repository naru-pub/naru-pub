export function BusinessFooter() {
  return (
    <footer className="border-t border-border px-6 py-8 text-sm text-muted-foreground">
      <dl className="mx-auto flex max-w-4xl flex-wrap gap-x-5 gap-y-2 leading-relaxed">
        <div className="flex gap-2">
          <dt className="font-medium text-foreground">상호명</dt>
          <dd>화양전자</dd>
        </div>
        <div className="flex gap-2">
          <dt className="font-medium text-foreground">사업자등록번호</dt>
          <dd>101-28-99756</dd>
        </div>
        <div className="flex gap-2">
          <dt className="font-medium text-foreground">대표자명</dt>
          <dd>서지혁</dd>
        </div>
        <div className="flex gap-2">
          <dt className="font-medium text-foreground">사업장 주소</dt>
          <dd>서울 성동구 연무장길 31 101동 1706호</dd>
        </div>
        <div className="flex gap-2">
          <dt className="font-medium text-foreground">유선번호</dt>
          <dd>000-0000-0000</dd>
        </div>
      </dl>
    </footer>
  );
}
