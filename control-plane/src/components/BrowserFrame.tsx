// A user's site is always shown inside a little browser window with its
// address on top, so a screenshot reads as a place you can visit.
export function BrowserFrame({
  address,
  children,
  className,
}: {
  address: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={`border-2 border-line bg-card ${className ?? ""}`}>
      <div className="flex h-7 items-center gap-1.5 overflow-hidden whitespace-nowrap border-b-2 border-line px-2.5 font-mono text-xs text-muted-foreground">
        <span aria-hidden="true" className="size-2 shrink-0 bg-foreground" />
        <span className="truncate">{address}</span>
      </div>
      {children}
    </div>
  );
}

// login.naru.pub, with the login name in ink.
export function SiteAddress({ loginName }: { loginName: string }) {
  return (
    <>
      <span className="font-medium text-foreground">{loginName}</span>.
      {process.env.NEXT_PUBLIC_DOMAIN}
    </>
  );
}
