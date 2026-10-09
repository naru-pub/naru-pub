"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { tabLinkClass } from "@/components/ui/tab-link";

export type AdminSection = { href: string; label: string };

export function AdminNav({ sections }: { sections: AdminSection[] }) {
  const pathname = usePathname();
  return (
    <nav className="flex min-w-0 overflow-x-auto border-b border-border [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      {sections.map((section) => {
        const active =
          section.href === "/admin"
            ? pathname === "/admin"
            : pathname.startsWith(section.href);
        return (
          <Link
            key={section.href}
            href={section.href}
            aria-current={active ? "page" : undefined}
            className={tabLinkClass(active)}
          >
            {section.label}
          </Link>
        );
      })}
    </nav>
  );
}
