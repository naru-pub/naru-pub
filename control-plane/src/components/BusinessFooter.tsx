import Image from "next/image";
import Link from "next/link";

const LINKS = [
  { href: "/board", label: "게시판" },
  { href: "/docs", label: "길잡이" },
  { href: "/supporter", label: "결제" },
  { href: "/open", label: "지표" },
  { href: "/design", label: "디자인" },
  { href: "https://x.com/naru_pub", label: "X" },
];

const BUSINESS = [
  ["상호명", "화양전자"],
  ["사업자등록번호", "101-28-99756"],
  ["통신판매업신고번호", "2026-서울성동-1013"],
  ["대표자명", "서지혁"],
  ["사업장 주소", "서울 성동구 연무장길 31 101동 1706호"],
  ["유선번호", "010-5828-3026"],
];

export function BusinessFooter() {
  return (
    <footer className="border-t-2 border-line bg-card">
      <div className="mx-auto flex max-w-7xl flex-wrap justify-between gap-8 px-4 py-10 sm:px-6 lg:px-8">
        <div className="flex flex-[1_1_240px] flex-col gap-3">
          <div className="flex items-center gap-2.5">
            <Image
              src="/logo.png"
              alt=""
              width={28}
              height={28}
              className="[image-rendering:pixelated]"
              style={{ filter: "var(--logo-filter, none)" }}
            />
            <span className="text-xl font-bold">나루</span>
          </div>
          <p className="text-sm text-muted-foreground">
            당신의 공간이 되는, 나루.
          </p>
          <nav
            aria-label="바닥글"
            className="flex flex-wrap gap-x-4 gap-y-1 text-sm"
          >
            {LINKS.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                className="text-link underline-offset-4 hover:underline"
              >
                {link.label}
              </Link>
            ))}
          </nav>
        </div>
        {/* Labels never wrap mid-word; long values wrap in their column. */}
        <dl className="grid flex-[2_1_420px] grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-xs leading-relaxed">
          {BUSINESS.map(([label, value]) => (
            <div key={label} className="contents">
              <dt className="whitespace-nowrap font-medium text-foreground">
                {label}
              </dt>
              <dd className="text-muted-foreground tabular-nums">{value}</dd>
            </div>
          ))}
        </dl>
      </div>
    </footer>
  );
}
