import { db } from "@/lib/database";
import { sql } from "kysely";
import { getHomepageUrl, getRenderedSiteUrl } from "@/lib/utils";
import Link from "next/link";
import Image from "next/image";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { AdCard } from "@/components/AdCard";
import { ONE_TIME_YEAR_AMOUNT, PLAN_AMOUNTS } from "@/lib/toss";
import { Info, ScrollText, History, BarChart3, Heart } from "lucide-react";

// A sparkline is drawn server-side as plain SVG. The charts on /open pull in
// recharts behind "use client", which is far too much JavaScript to put on the
// page every visitor loads for a decoration this small.
function Sparkline({ values, label }: { values: number[]; label: string }) {
  if (values.length < 2) return null;

  const width = 100;
  const height = 24;
  const max = Math.max(...values);
  const min = Math.min(...values);
  // A flat series would divide by zero; draw it along the baseline instead.
  const span = max - min || 1;
  const points = values.map((value, index) => {
    const x = (index / (values.length - 1)) * width;
    const y = height - ((value - min) / span) * height;
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  });

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      className="text-primary mt-2 h-6 w-full"
      role="img"
      aria-label={label}
    >
      <polygon
        points={`0,${height} ${points.join(" ")} ${width},${height}`}
        fill="currentColor"
        fillOpacity="0.12"
      />
      <polyline
        points={points.join(" ")}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

// The front page is the only page every visitor loads, so these stay pure SQL
// aggregates. /open can afford to pull rows and reduce in JS; this cannot.
// The two series are grouped in the database and come back a few dozen rows
// each, never one row per user.
async function getHeadlineStats() {
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 29);

  const [users, pageviews, edits, signupsByMonth, viewsByDay, editsByDay] =
    await Promise.all([
      db
        .selectFrom("users")
        .select(sql<number>`COUNT(*)`.as("count"))
        .executeTakeFirst(),
      db
        .selectFrom("pageview_daily_stats")
        .select(sql<number>`COALESCE(SUM(views), 0)`.as("count"))
        .executeTakeFirst(),
      db
        .selectFrom("edit_daily_stats")
        .select(sql<number>`COALESCE(SUM(edit_count), 0)`.as("count"))
        .executeTakeFirst(),
      db
        .selectFrom("users")
        .select([
          sql<Date>`DATE_TRUNC('month', created_at)`.as("month"),
          sql<number>`COUNT(*)`.as("count"),
        ])
        .groupBy(sql`DATE_TRUNC('month', created_at)`)
        .orderBy(sql`DATE_TRUNC('month', created_at)`)
        .execute(),
      db
        .selectFrom("pageview_daily_stats")
        .select(["date", sql<number>`COALESCE(SUM(views), 0)`.as("views")])
        .where("date", ">=", thirtyDaysAgo)
        .groupBy("date")
        .orderBy("date")
        .execute(),
      db
        .selectFrom("edit_daily_stats")
        .select(["date", sql<number>`COALESCE(SUM(edit_count), 0)`.as("edits")])
        .where("date", ">=", thirtyDaysAgo)
        .groupBy("date")
        .orderBy("date")
        .execute(),
    ]);

  // Signups per month become the cumulative curve the headline number ends on.
  let runningTotal = 0;
  const userTrend = signupsByMonth.map((row) => {
    runningTotal += Number(row.count);
    return runningTotal;
  });

  return {
    userCount: Number(users?.count ?? 0),
    totalViews: Number(pageviews?.count ?? 0),
    totalEdits: Number(edits?.count ?? 0),
    userTrend,
    viewTrend: viewsByDay.map((row) => Number(row.views)),
    editTrend: editsByDay.map((row) => Number(row.edits)),
  };
}

export default async function Home() {
  const [recentlyRenderedUsers, stats] = await Promise.all([
    db
      .selectFrom("users")
      .selectAll()
      .where("discoverable", "=", true)
      .orderBy("site_updated_at", "desc")
      .where("site_rendered_at", "is not", null)
      .execute(),
    getHeadlineStats(),
  ]);

  return (
    <div className="bg-background min-h-screen p-6">
      <div className="mx-auto max-w-7xl space-y-8">
        <Card className="bg-card border-2 border-border shadow-lg">
          <CardHeader className="bg-secondary border-b-2 border-border">
            <CardTitle className="text-foreground text-xl font-bold flex items-center gap-2">
              <Info size={20} /> 소개
            </CardTitle>
          </CardHeader>
          <CardContent className="p-6 space-y-4">
            <p className="text-muted-foreground text-base leading-relaxed">
              <strong className="text-primary">나루</strong>는 누구나 무료로
              사용할 수 있는 웹사이트 호스팅 서비스입니다.
            </p>
            <p className="text-muted-foreground text-base leading-relaxed">
              개인 홈페이지나 블로그를 손쉽게 만들고 공유할 수 있도록
              도와드립니다.
            </p>
          </CardContent>
        </Card>

        <Card className="bg-card border-2 border-border shadow-lg">
          <CardHeader className="bg-secondary border-b-2 border-border">
            <CardTitle className="text-foreground text-xl font-bold flex items-center gap-2">
              <BarChart3 size={20} /> 지표
            </CardTitle>
          </CardHeader>
          <CardContent className="p-6 space-y-4">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <div className="bg-background border border-border rounded p-3">
                <div className="text-2xl font-bold text-foreground tabular-nums">
                  {stats.userCount.toLocaleString("ko-KR")}명
                </div>
                <p className="text-xs text-muted-foreground">함께하는 사용자</p>
                <Sparkline values={stats.userTrend} label="월별 누적 사용자" />
              </div>
              <div className="bg-background border border-border rounded p-3">
                <div className="text-2xl font-bold text-foreground tabular-nums">
                  {stats.totalViews.toLocaleString("ko-KR")}
                </div>
                <p className="text-xs text-muted-foreground">지금까지의 조회</p>
                <Sparkline
                  values={stats.viewTrend}
                  label="최근 30일 페이지뷰"
                />
              </div>
              <div className="bg-background border border-border rounded p-3">
                <div className="text-2xl font-bold text-foreground tabular-nums">
                  {stats.totalEdits.toLocaleString("ko-KR")}
                </div>
                <p className="text-xs text-muted-foreground">지금까지의 편집</p>
                <Sparkline values={stats.editTrend} label="최근 30일 편집" />
              </div>
            </div>
            <Link
              href="/open"
              className="text-primary text-sm font-medium hover:underline"
            >
              전체 지표 보기 →
            </Link>
          </CardContent>
        </Card>

        <Card className="bg-card border-2 border-border shadow-lg">
          <CardHeader className="bg-secondary border-b-2 border-border">
            <CardTitle className="text-foreground text-xl font-bold flex items-center gap-2">
              <ScrollText size={20} /> 사용 안내
            </CardTitle>
          </CardHeader>
          <CardContent className="p-6 space-y-4">
            <div className="space-y-3 text-muted-foreground">
              <div className="bg-background border border-border rounded p-3">
                <strong className="text-foreground">💾 저장공간:</strong> 따로
                용량 제한을 두지 않습니다. 파일 하나는 10 MiB까지 올릴 수 있고,
                함께 쓰는 공간이니 적당한 선에서 부탁드려요.
              </div>

              <div className="bg-background border border-border rounded p-3">
                <strong className="text-foreground">🎵 미디어:</strong> 크기가
                큰 음악이나 영상은 되도록 SoundCloud나 YouTube로 게시해 주세요.
              </div>

              <div className="bg-background border border-border rounded p-3">
                <strong className="text-foreground">⚠️ 주의:</strong> 트래픽을
                과도하게 유발하는 행위는 자제해 주세요.
              </div>

              <div className="bg-background border border-border rounded p-3">
                <strong className="text-foreground">ℹ️ 면책:</strong> 나루는
                무료 서비스이며, 사용상 발생하는 문제에 대해 어떠한 책임도 지지
                않습니다.
              </div>

              <div className="bg-background border border-border rounded p-3">
                <strong className="text-foreground">📞 문의:</strong> 문의는{" "}
                <Link
                  href="https://x.com/naru_pub"
                  className="text-primary underline hover:text-primary/80"
                >
                  @naru_pub
                </Link>{" "}
                으로 부탁드립니다.
              </div>
            </div>
          </CardContent>
        </Card>

        {/* 카드사 심사는 비회원이 메인 페이지에서 상품과 가격을 바로 확인할 수
            있는지를 본다. 가격 없이 문의 창구만 있는 형태는 반려 사유다. */}
        <Card className="bg-card border-2 border-border shadow-lg">
          <CardHeader className="bg-secondary border-b-2 border-border">
            <CardTitle className="text-foreground text-xl font-bold flex items-center gap-2">
              <Heart size={20} /> 후원
            </CardTitle>
          </CardHeader>
          <CardContent className="p-6 space-y-4">
            <p className="text-muted-foreground text-base leading-relaxed">
              웹사이트 호스팅은 계속 무료입니다. 후원해 주시면 커스텀 도메인,
              데이터베이스, 방문자 현황 기능을 함께 쓰실 수 있습니다.
            </p>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <div className="bg-background border border-border rounded p-3">
                <div className="text-xl font-bold text-foreground tabular-nums">
                  월 {PLAN_AMOUNTS.month.toLocaleString("ko-KR")}원
                </div>
                <p className="text-xs text-muted-foreground">
                  정기 후원, 매월 자동 결제
                </p>
              </div>
              <div className="bg-background border border-border rounded p-3">
                <div className="text-xl font-bold text-foreground tabular-nums">
                  연 {PLAN_AMOUNTS.year.toLocaleString("ko-KR")}원
                </div>
                <p className="text-xs text-muted-foreground">
                  정기 후원, 매년 자동 결제
                </p>
              </div>
              <div className="bg-background border border-border rounded p-3">
                <div className="text-xl font-bold text-foreground tabular-nums">
                  {ONE_TIME_YEAR_AMOUNT.toLocaleString("ko-KR")}원
                </div>
                <p className="text-xs text-muted-foreground">
                  한 번만 결제, 1년 이용
                </p>
              </div>
            </div>
            <Link
              href="/support"
              className="text-primary text-sm font-medium hover:underline"
            >
              후원 안내 및 판매 정책 보기 →
            </Link>
          </CardContent>
        </Card>

        <div className="grid gap-6 md:grid-cols-2">
          <AdCard
            icon="🥒"
            title="오이카페"
            label="동맹 사이트 광고"
            imageSrc="/ad/8f1572d356a332381c53e1f7e6b77afb0e64f1bdb6a4b46c76a6bb6f5a680a30.png"
            imageAlt="오이카페 캐릭터"
            description="2000년도 감성의 웹 그림판, 오이카페"
            subtitle="오에카키 스타일로 그림을 그리고 넷캔도 즐겨보세요!"
            buttonText="오이 깎으러 가기 →"
            buttonHref="https://oeee.cafe"
          />
          <AdCard
            icon="🖋️"
            title="타이포 블루"
            label="동맹 사이트 광고"
            imageSrc="/ad/1339fc50a058b6d7f6a782c76d61839262459bd47c8e37c7421cc14b28bbfdba.png"
            imageAlt="타이포 블루 캐릭터"
            description="새로운 블로깅 플랫폼, 타이포 블루"
            subtitle="자신의 글을 메일링과 연합우주를 통해 발행하세요!"
            buttonText="글 쓰러 가기 →"
            buttonHref="https://typo.blue"
          />
          <AdCard
            icon="🐓"
            title="커뮹!"
            label="동맹 사이트 광고"
            imageSrc="/ad/8eb6bc2c4a2b73696ad1788fb98a6d59c8a3c21a15ddd418b1bf38800c65f317.png"
            imageAlt="커뮹! 캐릭터"
            description="마스토돈 스타일의 커뮤 플랫폼, 커뮹!"
            subtitle="편리한 총괄, 간편한 러닝! 커뮤 뛰러 오세요!"
            buttonText="커뮤 뛰러 가기 →"
            buttonHref="https://commu.ng"
          />
          <AdCard
            icon="👀"
            title="광고주를 찾고 있습니다"
            label="당신의 광고"
            imageSrc="/ad/0c88af5cb6aee0da1e19b8c7f75ee6a1fc11cda46729b5734f4cf2e45c65bede.png"
            imageAlt="귀여운 고양이"
            description="이 자리에 들어갈 광고를 찾고 있습니다"
            subtitle="광고 문의는 DM으로 부탁드립니다!"
            buttonText="광고 문의하러 가기 →"
            buttonHref="https://x.com/naru_pub"
          />
        </div>

        {recentlyRenderedUsers.length > 0 && (
          <Card className="bg-card border-2 border-border shadow-lg">
            <CardHeader className="bg-secondary border-b-2 border-border">
              <CardTitle className="text-foreground text-xl font-bold flex items-center gap-2">
                <History size={20} /> 최근 업데이트된
              </CardTitle>
            </CardHeader>
            <CardContent className="p-6">
              <div className="grid grid-cols-[repeat(auto-fill,minmax(min(220px,100%),1fr))] gap-4">
                {recentlyRenderedUsers.map((user) => {
                  const homepageUrl = getHomepageUrl(user.login_name);

                  return (
                    <div
                      key={user.id}
                      className="bg-card border border-border rounded-lg p-3 shadow-sm hover:shadow-md transition-shadow duration-200"
                    >
                      <Link
                        href={homepageUrl}
                        target="_blank"
                        className="block"
                      >
                        <div className="border border-border rounded mb-3 overflow-hidden">
                          <Image
                            src={getRenderedSiteUrl(
                              user.login_name,
                              user.site_rendered_at,
                            )}
                            alt="screenshot"
                            width={320}
                            height={240}
                            className="w-full h-auto hover:opacity-90 transition-opacity"
                          />
                        </div>
                        <Button
                          variant="outline"
                          className="w-full border-border text-muted-foreground hover:bg-background bg-card"
                        >
                          {user.login_name}
                        </Button>
                      </Link>
                    </div>
                  );
                })}
              </div>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
