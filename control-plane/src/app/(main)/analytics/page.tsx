import { validateRequest } from "@/lib/auth";
import { redirect } from "next/navigation";
import { db } from "@/lib/database";
import { sql } from "kysely";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { BarChart3, Users, Eye, TrendingUp } from "lucide-react";
import PageviewsChart from "./pageviews-chart";
import TopPagesTable from "./top-pages-table";
import TopReferrersTable from "./top-referrers-table";
import UserAgentsTable from "./user-agents-table";
import { userHasFeature } from "@/lib/entitlements";

async function getDailyPageviews(userId: string) {
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

  const results = await db
    .selectFrom("pageview_daily_stats")
    .select([
      sql<string>`TO_CHAR(date, 'YYYY-MM-DD')`.as("date"),
      "views",
      "unique_visitors",
    ])
    .where("user_id", "=", userId)
    .where("date", ">=", thirtyDaysAgo)
    .orderBy("date", "asc")
    .execute();

  // Fill in missing dates with zero values
  const chartData = [];
  const now = new Date();
  for (let i = 29; i >= 0; i--) {
    const date = new Date(now.getTime() - i * 24 * 60 * 60 * 1000);
    const dateStr = date.toISOString().slice(0, 10);
    const found = results.find((r) => r.date === dateStr);
    chartData.push({
      date: dateStr,
      views: found ? Number(found.views) : 0,
      uniqueVisitors: found ? Number(found.unique_visitors) : 0,
    });
  }

  return chartData;
}

async function getTopPages(userId: string) {
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

  const results = await db
    .selectFrom("pageview_daily_paths")
    .select([
      "path",
      sql<number>`SUM(views)`.as("views"),
      sql<number>`ROUND(hll_cardinality(hll_union_agg(visitors)))`.as(
        "unique_visitors",
      ),
    ])
    .where("user_id", "=", userId)
    .where("date", ">=", thirtyDaysAgo)
    .groupBy("path")
    .orderBy(sql`SUM(views)`, "desc")
    .limit(10)
    .execute();

  return results.map((r) => ({
    path: r.path,
    views: Number(r.views),
    uniqueVisitors: Number(r.unique_visitors),
  }));
}

async function getTopReferrers(userId: string) {
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

  const results = await db
    .selectFrom("pageview_daily_referrers")
    .select([
      sql<string>`COALESCE(NULLIF(referrer, ''), '(직접 방문)')`.as("referrer"),
      sql<number>`SUM(views)`.as("views"),
    ])
    .where("user_id", "=", userId)
    .where("date", ">=", thirtyDaysAgo)
    .groupBy("referrer")
    .orderBy(sql`SUM(views)`, "desc")
    .limit(10)
    .execute();

  return results.map((r) => ({
    referrer: r.referrer,
    views: Number(r.views),
  }));
}

async function getUserAgentBreakdown(userId: string) {
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

  const results = await db
    .selectFrom("pageview_daily_browsers")
    .select(["browser", sql<number>`SUM(views)`.as("views")])
    .where("user_id", "=", userId)
    .where("date", ">=", thirtyDaysAgo)
    .groupBy("browser")
    .orderBy(sql`SUM(views)`, "desc")
    .limit(10)
    .execute();

  return results.map((r) => ({ userAgent: r.browser, views: Number(r.views) }));
}

// Distinct visitors over a range of days: the union of the days' sketches,
// so a returning visitor counts once. Days without a sketch, from before
// sketches or past their retention, add their own counts.
function rangeUniqueVisitors() {
  return sql<number>`ROUND(COALESCE(hll_cardinality(hll_union_agg(visitors)), 0))
    + COALESCE(SUM(unique_visitors) FILTER (WHERE visitors IS NULL), 0)`;
}

async function getStats(userId: string) {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

  // Today's stats (from daily stats table, updated in real-time by proxy)
  const todayStats = await db
    .selectFrom("pageview_daily_stats")
    .select(["views", "unique_visitors"])
    .where("user_id", "=", userId)
    .where("date", "=", today)
    .executeTakeFirst();

  // Last 7 days stats
  const weekStats = await db
    .selectFrom("pageview_daily_stats")
    .select([
      sql<number>`SUM(views)`.as("views"),
      rangeUniqueVisitors().as("unique_visitors"),
    ])
    .where("user_id", "=", userId)
    .where("date", ">=", sevenDaysAgo)
    .executeTakeFirst();

  // Last 30 days stats
  const monthStats = await db
    .selectFrom("pageview_daily_stats")
    .select([
      sql<number>`SUM(views)`.as("views"),
      rangeUniqueVisitors().as("unique_visitors"),
    ])
    .where("user_id", "=", userId)
    .where("date", ">=", thirtyDaysAgo)
    .executeTakeFirst();

  // All time stats
  const allTimeStats = await db
    .selectFrom("pageview_daily_stats")
    .select([
      sql<number>`SUM(views)`.as("views"),
      sql<number>`SUM(unique_visitors)`.as("unique_visitors"),
    ])
    .where("user_id", "=", userId)
    .executeTakeFirst();

  return {
    today: {
      views: Number(todayStats?.views ?? 0),
      uniqueVisitors: Number(todayStats?.unique_visitors ?? 0),
    },
    week: {
      views: Number(weekStats?.views ?? 0),
      uniqueVisitors: Number(weekStats?.unique_visitors ?? 0),
    },
    month: {
      views: Number(monthStats?.views ?? 0),
      uniqueVisitors: Number(monthStats?.unique_visitors ?? 0),
    },
    allTime: {
      views: Number(allTimeStats?.views ?? 0),
      uniqueVisitors: Number(allTimeStats?.unique_visitors ?? 0),
    },
  };
}

export default async function AnalyticsPage() {
  const { user } = await validateRequest();

  if (!user) {
    redirect("/login");
  }

  if (!(await userHasFeature(user.id, "analytics"))) {
    redirect("/account");
  }

  const [dailyPageviews, topPages, topReferrers, userAgents, stats] =
    await Promise.all([
      getDailyPageviews(user.id),
      getTopPages(user.id),
      getTopReferrers(user.id),
      getUserAgentBreakdown(user.id),
      getStats(user.id),
    ]);

  return (
    <div className="bg-background min-h-screen">
      <div className="max-w-6xl mx-auto p-6 space-y-8">
        <Card className="bg-card border-2 border-line">
          <CardHeader className="border-b border-border">
            <CardTitle className="text-foreground text-xl font-bold flex items-center gap-2">
              <BarChart3 size={20} /> 사이트 분석
            </CardTitle>
          </CardHeader>
          <CardContent className="p-6">
            <p className="text-muted-foreground text-base leading-relaxed">
              <strong className="text-primary">{user.loginName}</strong>님의
              사이트 방문 현황을 확인하세요.
            </p>
          </CardContent>
        </Card>

        {/* Stats Cards */}
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          <Card className="bg-card border-2 border-line">
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2 border-b border-border">
              <CardTitle className="text-sm font-medium text-foreground">
                오늘
              </CardTitle>
              <Eye className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent className="p-4">
              <div className="text-2xl font-bold text-foreground tabular-nums">
                {stats.today.views}
              </div>
              <p className="text-xs text-muted-foreground">
                순방문자 {stats.today.uniqueVisitors}명
              </p>
            </CardContent>
          </Card>
          <Card className="bg-card border-2 border-line">
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2 border-b border-border">
              <CardTitle className="text-sm font-medium text-foreground">
                최근 7일
              </CardTitle>
              <TrendingUp className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent className="p-4">
              <div className="text-2xl font-bold text-foreground tabular-nums">
                {stats.week.views}
              </div>
              <p className="text-xs text-muted-foreground">
                순방문자 {stats.week.uniqueVisitors}명
              </p>
            </CardContent>
          </Card>
          <Card className="bg-card border-2 border-line">
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2 border-b border-border">
              <CardTitle className="text-sm font-medium text-foreground">
                최근 30일
              </CardTitle>
              <BarChart3 className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent className="p-4">
              <div className="text-2xl font-bold text-foreground tabular-nums">
                {stats.month.views}
              </div>
              <p className="text-xs text-muted-foreground">
                순방문자 {stats.month.uniqueVisitors}명
              </p>
            </CardContent>
          </Card>
          <Card className="bg-card border-2 border-line">
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2 border-b border-border">
              <CardTitle className="text-sm font-medium text-foreground">
                전체 기간
              </CardTitle>
              <Users className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent className="p-4">
              <div className="text-2xl font-bold text-foreground tabular-nums">
                {stats.allTime.views}
              </div>
              <p className="text-xs text-muted-foreground">
                순방문자 {stats.allTime.uniqueVisitors}명
              </p>
            </CardContent>
          </Card>
        </div>

        {/* Charts */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          <PageviewsChart data={dailyPageviews} />
          <TopPagesTable data={topPages} />
        </div>

        {/* Referrers & User Agents */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <TopReferrersTable data={topReferrers} />
          <UserAgentsTable data={userAgents} />
        </div>
      </div>
    </div>
  );
}
