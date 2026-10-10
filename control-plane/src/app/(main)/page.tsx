import { db } from "@/lib/database";
import { sql } from "kysely";
import Link from "next/link";
import Image from "next/image";
import { AdCard } from "@/components/AdCard";
import { BrowserFrame, SiteAddress } from "@/components/BrowserFrame";
import { PixelWave } from "@/components/PixelWave";
import { SiteGrid } from "@/components/SiteGrid";
import { getHomepageUrl, getRenderedSiteUrl } from "@/lib/site-urls";
import { validateRequest } from "@/lib/auth";
import { POST_KINDS, type PostKind } from "@/lib/board/constants";
import { listLatestPosts, type PostSummary } from "@/lib/board/posts";
import { postThumbnailUrl } from "./board/_components/Thumbnail";
import { HomeBoard, type HomePost } from "./board/_components/HomeBoard";
import { formatRelative } from "./board/_components/format";

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
    <div className="h-10 w-28 shrink-0">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        className="h-full w-full overflow-visible text-primary"
        role="img"
        aria-label={label}
      >
        <polyline
          points={points.join(" ")}
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinejoin="miter"
          vectorEffect="non-scaling-stroke"
        />
      </svg>
    </div>
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

const RECENT_SITES_ON_HOME = 12;

export default async function Home() {
  const [recentlyRenderedUsers, stats, latestByKind, { user }] =
    await Promise.all([
      db
        .selectFrom("users")
        .select(["id", "login_name", "site_rendered_at"])
        .where("discoverable", "=", true)
        .orderBy("site_updated_at", "desc")
        .where("site_rendered_at", "is not", null)
        // The rest are on /sites.
        .limit(RECENT_SITES_ON_HOME)
        .execute(),
      getHeadlineStats(),
      Promise.all(POST_KINDS.map((kind) => listLatestPosts(kind, 6))),
      validateRequest(),
    ]);

  // Plain data for the client card, times already formatted.
  const toHomePost = (post: PostSummary): HomePost => ({
    id: post.id,
    title: post.title,
    excerpt: post.excerpt,
    authorLoginName: post.authorLoginName,
    time: formatRelative(post.createdAt),
    replyCount: post.replyCount,
    applyCount: post.template ? post.template.applyCount : null,
    thumbnailUrl: postThumbnailUrl(post),
  });
  const latestForKind = (kind: PostKind) => latestByKind[POST_KINDS.indexOf(kind)];
  const boardPosts = {
    template: [...latestForKind("template"), ...latestForKind("site")]
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, 6)
      .map(toHomePost),
    question: latestForKind("question").map(toHomePost),
    chat: latestForKind("chat").map(toHomePost),
  };
  const heroSites = recentlyRenderedUsers.slice(0, 3);
  const statTiles = [
    {
      value: stats.userCount,
      caption: "명이 함께하고 있어요",
      trend: stats.userTrend,
      trendLabel: "월별 누적 사용자",
    },
    {
      value: stats.totalViews,
      caption: "번 사이트를 열어 봤어요",
      trend: stats.viewTrend,
      trendLabel: "최근 30일 페이지뷰",
    },
    {
      value: stats.totalEdits,
      caption: "번 고쳐 썼어요",
      trend: stats.editTrend,
      trendLabel: "최근 30일 편집",
    },
  ];

  return (
    <div className="min-h-screen">
      <section className="mx-auto flex max-w-7xl flex-wrap items-center gap-14 px-4 pb-14 pt-14 sm:px-6 sm:pt-20 lg:px-8">
        <div className="flex min-w-0 flex-[1_1_480px] flex-col gap-6">
          <p className="flex items-center gap-2.5 text-sm font-medium text-muted-foreground">
            <span aria-hidden="true" className="size-2.5 bg-primary" />
            무료 개인 홈페이지 호스팅
          </p>
          <h1 className="text-[clamp(2.5rem,5.2vw,4.25rem)] font-bold leading-[1.12] tracking-[-0.035em]">
            당신의 공간이 되는,
            <br />
            <span className="highlight">
              나루
            </span>
            .
          </h1>
          <p className="max-w-xl text-lg leading-relaxed text-muted-foreground">
            HTML 파일 몇 개면 충분해요. 브라우저에서 바로 고치고, 다른 사람이
            나눈 템플릿을 한 번에 적용해 시작할 수도 있어요.
          </p>
          {user ? (
            <div className="flex flex-wrap items-center gap-3">
              <Link
                href="/files"
                className="press inline-flex h-12 items-center border-2 border-line bg-primary px-6 font-semibold text-primary-foreground"
              >
                내 사이트 고치기 →
              </Link>
              <Link
                href={getHomepageUrl(user.loginName)}
                target="_blank"
                className="inline-flex h-12 items-center border-2 border-line bg-card px-5 font-mono text-sm hover:bg-accent"
              >
                <SiteAddress loginName={user.loginName} />
              </Link>
            </div>
          ) : (
            <form action="/signup" className="mt-1 flex flex-col gap-3">
              <label htmlFor="claim-username" className="sr-only">
                갖고 싶은 사이트 주소
              </label>
              <div className="flex max-w-xl items-stretch border-2 border-line bg-card font-mono shadow-hard focus-within:outline focus-within:outline-2 focus-within:outline-offset-4 focus-within:outline-ring">
                <span
                  aria-hidden="true"
                  className="hidden items-center pl-4 text-muted-foreground sm:flex"
                >
                  https://
                </span>
                <input
                  id="claim-username"
                  name="username"
                  type="text"
                  placeholder="내이름"
                  autoComplete="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  pattern="[a-z0-9]+(-[a-z0-9]+)*"
                  title="영문 소문자, 숫자, 하이픈(-)"
                  className="min-h-14 min-w-0 flex-1 bg-transparent px-3 text-[17px] font-medium outline-none placeholder:text-muted-foreground sm:px-1"
                />
                <span
                  aria-hidden="true"
                  className="flex items-center pr-3 text-muted-foreground"
                >
                  .{process.env.NEXT_PUBLIC_DOMAIN}
                </span>
                {/* eslint-disable-next-line react/forbid-elements -- joined to the address box; its edges are the box's */}
                <button
                  type="submit"
                  className="shrink-0 border-l-2 border-line bg-primary px-4 font-sans font-semibold text-primary-foreground hover:brightness-110 sm:px-5"
                >
                  만들기 →
                </button>
              </div>
              <p className="text-[13px] text-muted-foreground">
                가입하면 이 주소가 바로 내 사이트가 돼요. 이미 계정이 있다면{" "}
                <Link
                  href="/login"
                  className="text-link underline-offset-4 hover:underline"
                >
                  로그인
                </Link>
              </p>
            </form>
          )}
        </div>

        {heroSites.length === 3 && (
          <div
            aria-hidden="true"
            className="relative hidden h-[420px] min-w-0 flex-[1_1_420px] md:block"
          >
            {heroSites.map((site, index) => (
              <BrowserFrame
                key={site.id}
                address={<SiteAddress loginName={site.login_name} />}
                className={`absolute shadow-hard-lg ${
                  [
                    "left-0 top-6 w-[62%]",
                    "right-0 top-0 w-[46%]",
                    "bottom-0 right-[8%] w-[56%]",
                  ][index]
                }`}
              >
                <div className="relative aspect-[4/3] bg-muted">
                  <Image
                    src={getRenderedSiteUrl(
                      site.login_name,
                      site.site_rendered_at,
                    )}
                    alt=""
                    fill
                    sizes="320px"
                    priority
                    className="object-cover object-top"
                  />
                </div>
              </BrowserFrame>
            ))}
            <Image
              src="/logo.png"
              alt=""
              width={72}
              height={72}
              className="absolute bottom-4 left-[6%] [image-rendering:pixelated]"
              style={{ filter: "var(--logo-filter, none)" }}
            />
          </div>
        )}
      </section>

      <section
        aria-label="지표"
        className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8"
      >
        <div className="grid grid-cols-[repeat(auto-fit,minmax(min(260px,100%),1fr))] border-2 border-line bg-card">
          {statTiles.map((tile) => (
            <div
              key={tile.trendLabel}
              className="flex items-end justify-between gap-4 border-border px-6 py-5 [&:not(:last-child)]:border-b sm:[&:not(:last-child)]:border-b-0 sm:[&:not(:last-child)]:border-r"
            >
              <div>
                <div className="font-mono text-3xl font-semibold tabular-nums tracking-tight">
                  {tile.value.toLocaleString("ko-KR")}
                </div>
                <p className="text-sm text-muted-foreground">{tile.caption}</p>
              </div>
              <Sparkline values={tile.trend} label={tile.trendLabel} />
            </div>
          ))}
        </div>
        <p className="mt-2.5 text-right text-sm">
          <Link
            href="/open"
            className="text-link underline-offset-4 hover:underline"
          >
            전체 지표 보기 →
          </Link>
        </p>
      </section>

      {recentlyRenderedUsers.length > 0 && (
        <>
          <PixelWave className="mt-14" />
          <section className="border-b-2 border-line bg-card">
            <div className="mx-auto flex max-w-7xl flex-col gap-7 px-4 py-14 sm:px-6 lg:px-8">
              <SectionHeading
                title="방금 고쳐진 사이트들"
                description="나루 사람들이 지금 가꾸고 있는 공간이에요."
                href="/sites"
                linkText="모든 사이트 보기 →"
              />
              <SiteGrid users={recentlyRenderedUsers} />
            </div>
          </section>
        </>
      )}

      <section className="mx-auto flex max-w-7xl flex-col gap-6 px-4 py-16 sm:px-6 lg:px-8">
        <SectionHeading
          title="게시판"
          description="사이트 자랑, 템플릿, 그리고 이야기."
          href="/board/new"
          linkText="+ 새 글 쓰기"
        />
        <HomeBoard posts={boardPosts} />
      </section>

      <section>
        <div className="mx-auto flex max-w-7xl flex-col gap-8 px-4 py-16 sm:px-6 lg:px-8">
          <h2 className="text-3xl font-bold tracking-tight">
            나루는 이렇게 써요
          </h2>
          <ol className="grid grid-cols-[repeat(auto-fit,minmax(min(240px,100%),1fr))] gap-8">
            {STEPS.map((step, index) => (
              <li
                key={step.title}
                className="flex flex-col gap-2.5 border-t-2 border-line pt-4"
              >
                <span className="font-mono text-sm font-semibold text-primary">
                  {String(index + 1).padStart(2, "0")}
                </span>
                <h3 className="text-xl font-bold">{step.title}</h3>
                <p className="leading-relaxed text-muted-foreground">{step.body}</p>
              </li>
            ))}
          </ol>
          <dl className="grid grid-cols-[repeat(auto-fit,minmax(min(300px,100%),1fr))] gap-x-8 gap-y-3 border-[1.5px] border-line px-6 py-5 text-sm leading-relaxed">
            {RULES.map(([term, text]) => (
              <div key={term}>
                <dt className="inline font-bold">{term}</dt>
                <dd className="inline text-muted-foreground"> — {text}</dd>
              </div>
            ))}
            <div>
              <dt className="inline font-bold">문의</dt>
              <dd className="inline text-muted-foreground">
                {" "}
                —{" "}
                <Link
                  href="https://x.com/naru_pub"
                  className="underline underline-offset-4"
                >
                  @naru_pub
                </Link>{" "}
                으로 부탁드려요.
              </dd>
            </div>
          </dl>
        </div>
      </section>

      <section
        aria-labelledby="allies"
        className="mx-auto flex max-w-7xl flex-col gap-5 px-4 py-14 sm:px-6 lg:px-8"
      >
        <div className="flex items-center gap-3">
          <h2 id="allies" className="text-lg font-bold">
            동맹 사이트
          </h2>
          <span className="inline-flex h-[22px] items-center border-[1.5px] border-current px-1.5 text-xs font-semibold text-muted-foreground">
            광고
          </span>
        </div>
        <div className="grid grid-cols-[repeat(auto-fit,minmax(min(300px,100%),1fr))] gap-4">
          <AdCard
            title="오이카페"
            imageSrc="/ad/8f1572d356a332381c53e1f7e6b77afb0e64f1bdb6a4b46c76a6bb6f5a680a30.png"
            imageAlt="오이카페 캐릭터"
            description="2000년대 감성의 웹 그림판. 오에카키로 그리고 넷캔도 즐겨요."
            href="https://oeee.cafe"
          />
          <AdCard
            title="타이포 블루"
            imageSrc="/ad/1339fc50a058b6d7f6a782c76d61839262459bd47c8e37c7421cc14b28bbfdba.png"
            imageAlt="타이포 블루 캐릭터"
            description="새로운 블로깅 플랫폼. 메일링과 연합우주로 글을 발행해요."
            href="https://typo.blue"
          />
          <AdCard
            title="이 자리가 비어 있어요"
            imageSrc="/ad/0c88af5cb6aee0da1e19b8c7f75ee6a1fc11cda46729b5734f4cf2e45c65bede.png"
            imageAlt="귀여운 고양이"
            description="광고 문의는 DM으로 부탁드려요."
            href="https://x.com/naru_pub"
            vacant
          />
        </div>
      </section>
    </div>
  );
}

const STEPS = [
  {
    title: "가입하면 주소가 생겨요",
    body: `내 아이디가 곧 아이디.${process.env.NEXT_PUBLIC_DOMAIN} 주소가 돼요.`,
  },
  {
    title: "브라우저에서 고쳐요",
    body: "파일을 올리거나 편집기에서 HTML·CSS·JS를 바로 써요. 템플릿으로 시작해도 좋아요.",
  },
  {
    title: "게시판에 자랑해요",
    body: "사이트를 소개하면 스크린샷이 자동으로 붙어요.",
  },
];

const RULES = [
  [
    "저장공간",
    "따로 용량 제한은 없어요. 파일 하나는 10 MiB까지, 함께 쓰는 공간이니 적당히 부탁드려요.",
  ],
  ["미디어", "큰 음악이나 영상은 되도록 SoundCloud나 YouTube로 올려 주세요."],
  ["주의", "트래픽을 과도하게 유발하는 행위는 삼가 주세요."],
  [
    "면책",
    "나루는 무료 서비스이며, 사용상 발생하는 문제에 대해 어떠한 책임도 지지 않습니다.",
  ],
];

function SectionHeading({
  title,
  description,
  href,
  linkText,
}: {
  title: string;
  description: string;
  href: string;
  linkText: string;
}) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div className="space-y-1.5">
        <h2 className="text-3xl font-bold tracking-tight">{title}</h2>
        <p className="text-muted-foreground">{description}</p>
      </div>
      <Link
        href={href}
        className="text-sm font-medium text-link underline-offset-4 hover:underline"
      >
        {linkText}
      </Link>
    </div>
  );
}
