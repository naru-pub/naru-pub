"use client";

import Link from "next/link";
import {
  BadgeCheck,
  BookOpen,
  Code2,
  BarChart3,
  Database,
  Github,
  Globe2,
  Globe,
  Images,
  LogOut,
  Settings,
  ShieldCheck,
  User,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

const TRIGGER_CLASS =
  "text-muted-foreground hover:text-foreground hover:bg-accent px-3 py-2 rounded-lg text-sm font-medium transition-all duration-200";

type ExtensionItem = {
  href: string;
  label: string;
  icon: React.ReactNode;
  enabled: boolean;
};

export function ExtensionsMenu({
  analytics,
  database,
  customDomains,
  githubDeploys,
}: {
  analytics: boolean;
  database: boolean;
  customDomains: boolean;
  githubDeploys: boolean;
}) {
  const items: ExtensionItem[] = [
    {
      href: "/analytics",
      label: "분석",
      icon: <BarChart3 size={16} />,
      enabled: analytics,
    },
    {
      href: "/database",
      label: "데이터베이스",
      icon: <Database size={16} />,
      enabled: database,
    },
    {
      href: "/media",
      label: "미디어 라이브러리",
      icon: <Images size={16} />,
      enabled: database,
    },
    {
      href: "/domains",
      label: "커스텀 도메인",
      icon: <Globe size={16} />,
      enabled: customDomains,
    },
    {
      href: "/deploys",
      label: "GitHub 배포",
      icon: <Github size={16} />,
      enabled: githubDeploys,
    },
  ];

  // A menu of nothing but locked rows would be a dead end, so it only appears
  // once at least one extension is actually available.
  if (!items.some((item) => item.enabled)) {
    return null;
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger className={TRIGGER_CLASS}>
        확장 기능
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel className="flex items-center gap-2">
          <BadgeCheck size={16} />
          확장 기능
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {items.map((item) =>
          item.enabled ? (
            <DropdownMenuItem key={item.href} asChild>
              <Link href={item.href} className="flex items-center gap-2">
                {item.icon}
                {item.label}
              </Link>
            </DropdownMenuItem>
          ) : (
            // Shown rather than hidden so the menu says what supporting adds.
            <DropdownMenuItem key={item.href} disabled>
              <span className="flex items-center gap-2">
                {item.icon}
                {item.label}
                <span className="text-xs">후원자 전용</span>
              </span>
            </DropdownMenuItem>
          ),
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// /support and /support/payments are reachable by URL for any signed-in user
// but deliberately unlinked, so nothing here points at them.
export function DocsMenu() {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger className={TRIGGER_CLASS}>
        길잡이
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel className="flex items-center gap-2">
          <BookOpen size={16} />
          길잡이
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link href="/docs" className="flex items-center gap-2">
            전체 보기
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <Link href="/docs/database" className="flex items-center gap-2">
            <Database size={16} />
            데이터베이스
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <Link href="/docs/media" className="flex items-center gap-2">
            <Images size={16} />
            미디어 라이브러리
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <Link href="/docs/sdk/1.0.0" className="flex items-center gap-2">
            <Code2 size={16} />
            SDK 레퍼런스
          </Link>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function AccountMenu({
  loginName,
  paymentOperator,
}: {
  loginName: string;
  paymentOperator: boolean;
}) {
  async function logout() {
    try {
      const response = await fetch("/api/account/logout", { method: "POST" });
      if (response.ok) {
        window.location.href = "/";
      }
    } catch (error) {
      console.error("Logout error:", error);
    }
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger className={TRIGGER_CLASS}>계정</DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel className="flex items-center gap-2">
          <User size={16} />
          {loginName}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link href="/account" className="flex items-center gap-2">
            <Settings size={16} />
            계정 관리
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <Link href="/presence" className="flex items-center gap-2">
            <Globe2 size={16} />
            공개 설정
          </Link>
        </DropdownMenuItem>
        {paymentOperator && (
          <DropdownMenuItem asChild>
            <Link href="/admin" className="flex items-center gap-2">
              <ShieldCheck size={16} />
              운영
            </Link>
          </DropdownMenuItem>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={logout}>
          <span className="flex items-center gap-2">
            <LogOut size={16} />
            로그아웃
          </span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
