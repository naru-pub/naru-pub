"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

export type AdminSection = { href: string; label: string };

export function AdminNav({ sections }: { sections: AdminSection[] }) {
  const pathname = usePathname();
  return (
    <nav className="-mx-1 flex flex-wrap gap-1 border-b-2 border-line">
      {sections.map((section) => {
        const active =
          section.href === "/admin"
            ? pathname === "/admin"
            : pathname.startsWith(section.href);
        return (
          <Link
            key={section.href}
            href={section.href}
            className={
              active
                ? "-mb-0.5 border-b-2 border-primary px-3 py-2 font-bold text-foreground"
                : "px-3 py-2 text-muted-foreground hover:text-foreground"
            }
          >
            {section.label}
          </Link>
        );
      })}
    </nav>
  );
}
