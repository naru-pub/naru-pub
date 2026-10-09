const links = [
  ["/docs", "길잡이 홈", "home"],
  ["/docs/database", "데이터베이스", "database"],
  ["/docs/media", "미디어", "media"],
  ["/docs/sdk/1.0.0", "SDK 1.0.0", "sdk"],
] as const;

export default function DocsNav({ current }: { current: string }) {
  return (
    <nav aria-label="문서" className="mb-10">
      <ul className="flex flex-wrap gap-2 text-sm">
        {links.map(([href, label, key]) => (
          <li key={href}>
            <a
              href={href}
              aria-current={current === key ? "page" : undefined}
              className={`block px-3 py-1.5 transition-colors ${
                current === key
                  ? "border-2 border-line bg-foreground text-background"
                  : "border-2 border-transparent text-muted-foreground hover:border-line hover:text-foreground"
              }`}
            >
              {label}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
