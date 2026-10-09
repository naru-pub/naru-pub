import type { Metadata } from "next";
import Link from "next/link";
import { sql } from "kysely";
import { Globe } from "lucide-react";
import { db } from "@/lib/database";
import { SiteGrid } from "@/components/SiteGrid";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export const metadata: Metadata = {
  title: "모든 사이트 · 나루",
  description: "나루에서 공개된 사이트를 최근 업데이트순으로 모았어요.",
};

const SITES_PER_PAGE = 48;

// Every discoverable site with a screenshot, newest update first: the whole
// list behind the home page's 최근 업데이트된.
export default async function SitesPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string }>;
}) {
  const requested = Number.parseInt((await searchParams).page ?? "1", 10);
  const discoverable = db
    .selectFrom("users")
    .where("discoverable", "=", true)
    .where("site_rendered_at", "is not", null);

  const { count } = await discoverable
    .select(sql<number>`count(*)::int`.as("count"))
    .executeTakeFirstOrThrow();
  const pageCount = Math.max(1, Math.ceil(count / SITES_PER_PAGE));
  const page = Math.min(
    pageCount,
    Math.max(1, Number.isNaN(requested) ? 1 : requested),
  );

  const users = await discoverable
    .select(["id", "login_name", "site_rendered_at"])
    .orderBy("site_updated_at", "desc")
    .orderBy("id", "desc")
    .limit(SITES_PER_PAGE)
    .offset((page - 1) * SITES_PER_PAGE)
    .execute();

  const href = (target: number) =>
    target > 1 ? `/sites?page=${target}` : "/sites";

  return (
    <div className="bg-background min-h-screen p-6">
      <div className="mx-auto max-w-7xl space-y-8">
        <Card className="bg-card border-2 border-line">
          <CardHeader className="border-b border-border">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <CardTitle className="text-foreground text-xl font-bold flex items-center gap-2">
                <Globe size={20} /> 모든 사이트
              </CardTitle>
              <span className="text-sm text-muted-foreground">
                {count.toLocaleString("ko-KR")}개 · 최근 업데이트순
              </span>
            </div>
          </CardHeader>
          <CardContent className="p-6 space-y-6">
            {users.length === 0 ? (
              <p className="text-muted-foreground text-sm">
                아직 공개된 사이트가 없어요.
              </p>
            ) : (
              <SiteGrid users={users} />
            )}
            {pageCount > 1 && (
              <nav
                aria-label="페이지"
                className="flex items-center justify-center gap-4 text-sm"
              >
                {page > 1 ? (
                  <Link
                    href={href(page - 1)}
                    className="text-primary hover:underline"
                  >
                    ← 이전
                  </Link>
                ) : (
                  <span className="text-muted-foreground">← 이전</span>
                )}
                <span className="text-foreground tabular-nums">
                  {page} / {pageCount}
                </span>
                {page < pageCount ? (
                  <Link
                    href={href(page + 1)}
                    className="text-primary hover:underline"
                  >
                    다음 →
                  </Link>
                ) : (
                  <span className="text-muted-foreground">다음 →</span>
                )}
              </nav>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
