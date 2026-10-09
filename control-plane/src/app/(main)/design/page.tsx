import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { Download } from "lucide-react";

import { BrowserFrame, SiteAddress } from "@/components/BrowserFrame";
import { PixelWave } from "@/components/PixelWave";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { KindBadge } from "../board/_components/KindBadge";
import { PostTitle } from "../board/_components/PostTitle";
import { ContextMenuDemo, DialogDemo, RadioDemo, TabsDemo } from "./Demos";
import { TokenValue } from "./TokenValue";

export const metadata: Metadata = {
  title: "디자인 | 나루",
  description: "나루의 디자인 언어, 종이배: 색, 글꼴, 모양, 구성 요소",
};

const SECTIONS = [
  ["principles", "원칙"],
  ["color", "색"],
  ["type", "글꼴"],
  ["shape", "모양"],
  ["components", "구성 요소"],
  ["usage", "쓰는 법"],
] as const;

const PRINCIPLES = [
  {
    title: "선은 먹, 면은 종이",
    body: "테두리는 2px 먹색 하나. 흐린 그림자, 둥근 모서리, 카드 속 카드는 쓰지 않아요. 가는 1px 선은 목록을 나눌 때만.",
  },
  {
    title: "색은 깃발 하나",
    body: "파랑은 누르거나 고를 수 있는 것에만 써요. 노랑은 형광펜처럼 화면에 하나, 템플릿 표시나 강조에.",
  },
  {
    title: "주인공은 사용자 사이트",
    body: "나루의 화면은 조용히 물러서고, 사용자들의 알록달록한 홈페이지가 가장 먼저 보이게 해요.",
  },
];

// Every color is an HSL triple on :root and .dark in globals.css, used as
// hsl(var(--name)) through Tailwind. Values shown are read from the page.
const COLORS = [
  {
    token: "background",
    name: "ground",
    utility: "bg-background",
    use: "페이지 바탕",
  },
  {
    token: "card",
    name: "surface",
    utility: "bg-card",
    use: "카드, 내비게이션, 바닥글",
  },
  {
    token: "foreground",
    name: "ink",
    utility: "text-foreground",
    use: "본문 글자",
  },
  {
    token: "muted-foreground",
    name: "ink-2",
    utility: "text-muted-foreground",
    use: "설명, 메타 정보",
  },
  {
    token: "line",
    name: "line",
    utility: "border-line",
    use: "2px 테두리, 단단한 구분선",
  },
  {
    token: "border",
    name: "hairline",
    utility: "border-border",
    use: "1px 목록 구분선",
  },
  {
    token: "primary",
    name: "flag",
    utility: "bg-primary",
    use: "주 버튼, 선택 표시, 그래프",
  },
  {
    token: "link",
    name: "flag text",
    utility: "text-link",
    use: "바탕 위 링크 글자",
  },
  {
    token: "accent",
    name: "wash",
    utility: "bg-accent",
    use: "가리킨 항목, 옅은 강조 면",
  },
  {
    token: "sun",
    name: "sun",
    utility: "bg-sun",
    use: "형광펜: 템플릿, 제목 밑줄",
  },
  {
    token: "destructive",
    name: "danger",
    utility: "text-destructive",
    use: "삭제, 오류",
  },
  {
    token: "success",
    name: "success",
    utility: "text-success",
    use: "완료, 해결됨",
  },
  {
    token: "warning",
    name: "warning",
    utility: "text-warning",
    use: "주의, 만료 예정",
  },
];

const TYPE_SCALE = [
  {
    sample: "당신의 공간이 되는",
    spec: "Display · 44–68 / 700 / -0.035em",
    className: "text-5xl font-bold tracking-[-0.035em]",
  },
  {
    sample: "방금 고쳐진 사이트들",
    spec: "H2 · text-3xl / 700",
    className: "text-3xl font-bold tracking-tight",
  },
  {
    sample: "게시판 안내",
    spec: "H3 · text-xl / 700",
    className: "text-xl font-bold",
  },
  {
    sample: "HTML 파일 몇 개면 충분해요.",
    spec: "Body · text-base / 400 / 1.7",
    className: "text-base leading-relaxed",
  },
  {
    sample: "설명과 메타 정보는 한 단계 작게.",
    spec: "Small · text-sm / ink-2",
    className: "text-sm text-muted-foreground",
  },
  {
    sample: "seaunion.naru.pub · 12,251",
    spec: "Mono · font-mono / 500",
    className: "font-mono font-medium",
  },
];

export default function DesignPage() {
  return (
    <div className="min-h-screen">
      <header className="border-b-2 border-line bg-card">
        <div className="mx-auto flex max-w-6xl flex-col gap-6 px-4 py-14 sm:px-6 lg:px-8">
          <p className="font-mono text-sm text-muted-foreground">
            NARU / DESIGN
          </p>
          <h1 className="flex items-center gap-4 text-5xl font-bold tracking-[-0.04em] sm:text-6xl">
            <Image
              src="/logo.png"
              alt=""
              width={56}
              height={56}
              className="[image-rendering:pixelated]"
              style={{ filter: "var(--logo-filter, none)" }}
            />
            종이배
          </h1>
          <p className="max-w-2xl text-lg leading-relaxed text-muted-foreground">
            나루의 디자인 언어예요. 로고의 픽셀 종이배에서 출발했어요. 먹색 선,
            종이 바탕, 깃발 파랑. 각진 모서리에 흐림 없는 그림자, 그리고
            주소·숫자·아이디처럼 기계가 읽는 글자는 고정폭 글꼴로 써요.
          </p>
          <nav
            aria-label="이 페이지"
            className="flex flex-wrap gap-x-5 gap-y-1 text-sm font-medium"
          >
            {SECTIONS.map(([id, label]) => (
              <a
                key={id}
                href={`#${id}`}
                className="text-link underline-offset-4 hover:underline"
              >
                {label}
              </a>
            ))}
          </nav>
        </div>
      </header>
      <PixelWave />

      <div className="mx-auto flex max-w-6xl flex-col gap-20 px-4 py-16 sm:px-6 lg:px-8">
        <Section id="principles" title="원칙">
          <ol className="grid gap-8 sm:grid-cols-3">
            {PRINCIPLES.map((principle, index) => (
              <li
                key={principle.title}
                className="flex flex-col gap-2 border-t-2 border-line pt-4"
              >
                <span className="font-mono text-sm font-semibold text-link">
                  {String(index + 1).padStart(2, "0")}
                </span>
                <h3 className="text-lg font-bold">{principle.title}</h3>
                <p className="text-sm leading-relaxed text-muted-foreground">
                  {principle.body}
                </p>
              </li>
            ))}
          </ol>
        </Section>

        <Section
          id="color"
          title="색"
          description="모든 색은 globals.css의 토큰이에요. 컴포넌트에 gray-600, green-100 같은 날색을 직접 쓰지 말고 토큰을 쓰세요. 밝은 테마와 어두운 테마는 같은 이름에 다른 값이 들어 있어요."
        >
          <div className="overflow-x-auto border-2 border-line bg-card">
            <table className="w-full min-w-[640px] text-sm">
              <thead>
                <tr className="border-b-2 border-line text-left text-xs text-muted-foreground">
                  <th className="px-4 py-3 font-semibold">토큰</th>
                  <th className="px-4 py-3 font-semibold">밝게</th>
                  <th className="px-4 py-3 font-semibold">어둡게</th>
                  <th className="px-4 py-3 font-semibold">쓰는 곳</th>
                </tr>
              </thead>
              <tbody>
                {COLORS.map((color) => (
                  <tr
                    key={color.token}
                    className="border-b border-border last:border-b-0"
                  >
                    <td className="px-4 py-3">
                      <div className="font-bold">{color.name}</div>
                      <code className="font-mono text-xs text-muted-foreground">
                        --{color.token} · {color.utility}
                      </code>
                    </td>
                    {(["light", "dark"] as const).map((theme) => (
                      <td key={theme} className="px-4 py-3">
                        <div
                          className={`${theme} flex items-center gap-3 bg-background p-2 text-foreground`}
                        >
                          <span
                            className="size-9 shrink-0 border-2 border-line"
                            style={{ background: `hsl(var(--${color.token}))` }}
                          />
                          <span className="font-mono text-xs text-foreground">
                            <TokenValue name={color.token} />
                          </span>
                        </div>
                      </td>
                    ))}
                    <td className="px-4 py-3 text-muted-foreground">
                      {color.use}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-sm leading-relaxed text-muted-foreground">
            상태 색은 글자로 쓰거나{" "}
            <code className="font-mono text-foreground">bg-success/10</code>{" "}
            처럼 옅게 깔아 써요. 깃발 위 글자는{" "}
            <code className="font-mono text-foreground">
              text-primary-foreground
            </code>
            , 바탕 위 링크는 대비가 더 높은{" "}
            <code className="font-mono text-foreground">text-link</code>예요.
          </p>
        </Section>

        <Section
          id="type"
          title="글꼴"
          description="IBM Plex Sans KR과 IBM Plex Mono. 한 가족이라 섞어 써도 획이 맞아요. 고정폭은 주소, 숫자, 아이디, 코드처럼 라틴 글자로 된 기계의 말에만 써요. 한글은 낱말이든 단추든 늘 Sans로."
        >
          <div className="divide-y divide-border border-2 border-line bg-card">
            {TYPE_SCALE.map((row) => (
              <div
                key={row.spec}
                className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 px-6 py-4"
              >
                <span className={row.className}>{row.sample}</span>
                <span className="font-mono text-xs text-muted-foreground">
                  {row.spec}
                </span>
              </div>
            ))}
          </div>
          <p className="text-sm leading-relaxed text-muted-foreground">
            본문은{" "}
            <code className="font-mono text-foreground">
              word-break: keep-all
            </code>
            로 낱말 사이에서만 줄을 바꿔요. 숫자는{" "}
            <code className="font-mono text-foreground">tabular-nums</code>로
            자릿수를 맞춰요.
          </p>
        </Section>

        <Section id="shape" title="모양">
          <div className="grid gap-8 sm:grid-cols-2 lg:grid-cols-4">
            <Motif
              title="각진 모서리"
              body="--radius는 0. rounded-full은 점과 아바타에만."
              utility="rounded-none"
            >
              <div className="h-14 w-28 border-2 border-line bg-accent" />
            </Motif>
            <Motif
              title="누르는 면"
              body="흐림 없는 먹색 그림자. 가리키면 떠오르고, 누르면 들어가요."
              utility=".press · shadow-hard"
            >
              <Button>눌러 보기</Button>
            </Motif>
            <Motif
              title="떠오르는 카드"
              body="링크인 카드는 가리킬 때만 그림자가 생겨요."
              utility=".lift"
            >
              <a
                href="#shape"
                className="lift block h-14 w-28 border-2 border-line bg-card"
                aria-label="떠오르는 카드 예시"
              />
            </Motif>
            <Motif
              title="픽셀 물결"
              body="나루터의 물. 큰 구획 사이에 한 줄만."
              utility="<PixelWave />"
            >
              <PixelWave className="w-40" />
            </Motif>
          </div>
          <div className="grid gap-8 sm:grid-cols-2">
            <div className="flex flex-col gap-3">
              <h3 className="font-bold">브라우저 틀</h3>
              <p className="text-sm leading-relaxed text-muted-foreground">
                사용자 사이트는 늘 주소줄과 함께 보여 줘요. 스크린샷이 아직
                없으면 muted 면이 자리를 지켜요.{" "}
                <code className="font-mono text-foreground">
                  &lt;BrowserFrame /&gt;
                </code>
              </p>
              <BrowserFrame
                address={<SiteAddress loginName="example" />}
                className="max-w-xs"
              >
                <div className="aspect-[4/3] bg-muted" />
              </BrowserFrame>
            </div>
            <div className="flex flex-col gap-3">
              <h3 className="font-bold">형광펜</h3>
              <p className="text-sm leading-relaxed text-muted-foreground">
                화면에서 가장 중요한 낱말 하나에만 sun 밑줄을 그어요.
              </p>
              <p className="text-4xl font-bold tracking-tight">
                당신의 <span className="highlight">공간</span>
              </p>
            </div>
          </div>
        </Section>

        <Section
          id="components"
          title="구성 요소"
          description="src/components/ui의 실제 컴포넌트예요. 왼쪽은 밝은 테마, 오른쪽은 어두운 테마."
        >
          <ComponentRow title="버튼" source="ui/button.tsx">
            <div className="flex flex-wrap items-center gap-3">
              <Button>만들기 →</Button>
              <Button variant="outline">+ 새 글 쓰기</Button>
              <Button variant="secondary">보조</Button>
              <Button variant="ghost">고스트</Button>
              <Button variant="destructive">삭제</Button>
              <Button variant="link">링크 →</Button>
              <Button disabled>못 누름</Button>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <Button size="sm">sm</Button>
              <Button>default</Button>
              <Button size="lg">lg</Button>
            </div>
          </ComponentRow>

          <ComponentRow
            title="태그"
            source="ui/badge.tsx · board/KindBadge.tsx"
          >
            <div className="flex flex-wrap items-center gap-2">
              <Badge>default</Badge>
              <Badge variant="outline">광고</Badge>
              <Badge variant="link">link</Badge>
              <Badge variant="sun">sun</Badge>
              <Badge variant="success">해결됨</Badge>
              <Badge variant="warning">만료 예정</Badge>
              <Badge variant="destructive">오류</Badge>
              <Badge variant="secondary">secondary</Badge>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <KindBadge kind="template" />
              <KindBadge kind="site" />
              <KindBadge kind="question" />
              <KindBadge kind="chat" />
            </div>
          </ComponentRow>

          <ComponentRow
            title="입력"
            source="ui/input · textarea · select · checkbox · radio-group"
          >
            <div className="grid w-full max-w-xs gap-2">
              <Label>아이디</Label>
              <Input placeholder="example" />
            </div>
            <Textarea
              className="max-w-xs"
              placeholder="답글을 남겨 보세요"
              aria-label="예시 글상자"
            />
            <Select
              aria-label="정렬"
              defaultValue="new"
              wrapperClassName="w-40"
            >
              <option value="new">최신순</option>
              <option value="name">이름순</option>
              <option value="size">크기순</option>
            </Select>
            <div className="flex items-center gap-2">
              <Checkbox defaultChecked aria-label="예시 체크박스" />
              <span className="text-sm">연합우주에 알리기</span>
            </div>
            <RadioDemo />
          </ComponentRow>

          <ComponentRow title="카드" source="ui/card.tsx">
            <Card className="w-full max-w-sm">
              <CardHeader>
                <CardTitle>템플릿으로 시작하기</CardTitle>
                <CardDescription>
                  누군가 나눈 폴더를 한 번에 적용해요.
                </CardDescription>
              </CardHeader>
              <CardContent className="flex items-center justify-between gap-3">
                <span className="min-w-0">
                  <span className="block font-bold">
                    <PostTitle title="." />
                  </span>
                  <span className="flex items-center gap-1 text-xs font-semibold text-link">
                    <Download size={12} aria-hidden="true" />
                    3회 적용
                  </span>
                </span>
                <Button size="sm">적용</Button>
              </CardContent>
            </Card>
          </ComponentRow>

          <ComponentRow
            title="탭"
            source="ui/tabs.tsx · 페이지 이동 탭은 tabLinkClass()"
          >
            <TabsDemo />
          </ComponentRow>

          <ComponentRow
            title="대화상자와 확인"
            source="ui/dialog.tsx · ui/confirm.tsx (useConfirm)"
          >
            <DialogDemo />
            <p className="text-sm text-muted-foreground">
              window.confirm() 대신{" "}
              <code className="font-mono text-foreground">
                await confirm(&#123; title, destructive &#125;)
              </code>
            </p>
          </ComponentRow>

          <ComponentRow title="오른쪽 클릭 메뉴" source="ui/context-menu.tsx">
            <ContextMenuDemo />
          </ComponentRow>
        </Section>

        <Section id="usage" title="쓰는 법">
          <div className="grid gap-6 sm:grid-cols-2">
            <UsageList
              title="이렇게"
              tone="text-success"
              items={[
                "테두리는 border-2 border-line, 목록 구분은 border-border",
                "누를 수 있는 채운 버튼에만 .press 그림자",
                "링크인 카드는 .lift, 제목 링크에 after:absolute after:inset-0",
                "주소·숫자·아이디·코드는 font-mono, 한글은 늘 Sans",
                "빈 목록에는 안내 문장과 첫 행동 링크",
                "버튼·입력·선택·탭·대화상자는 늘 components/ui에서",
                "지우기 전 확인은 useConfirm(), destructive: true",
                "새 색이 필요하면 globals.css에 토큰부터, 그다음 이 페이지에",
              ]}
            />
            <UsageList
              title="이렇게 말고"
              tone="text-destructive"
              items={[
                "shadow-lg 같은 흐린 그림자, rounded-lg 같은 둥근 모서리",
                "카드 안에 또 카드, 회색 머리띠를 두른 카드 머리",
                "text-gray-600, bg-green-100 같은 날색",
                "한글을 고정폭 글꼴로 (띄어쓰기가 벌어져요)",
                "아이콘 대신 이모지",
                "<button>, <select>, window.confirm()을 직접 쓰기",
                "한 화면에 sun 강조 여러 개",
              ]}
            />
          </div>
          <p className="text-sm text-muted-foreground">
            고칠 곳을 찾았다면{" "}
            <Link
              href="/board"
              className="text-link underline-offset-4 hover:underline"
            >
              게시판
            </Link>
            에 알려 주세요.
          </p>
        </Section>
      </div>
    </div>
  );
}

function Section({
  id,
  title,
  description,
  children,
}: {
  id: string;
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <section
      id={id}
      aria-labelledby={`${id}-title`}
      className="flex scroll-mt-8 flex-col gap-6"
    >
      <div className="space-y-2">
        <h2 id={`${id}-title`} className="text-3xl font-bold tracking-tight">
          {title}
        </h2>
        {description && (
          <p className="max-w-3xl leading-relaxed text-muted-foreground">
            {description}
          </p>
        )}
      </div>
      {children}
    </section>
  );
}

function Motif({
  title,
  body,
  utility,
  children,
}: {
  title: string;
  body: string;
  utility: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex h-28 items-center justify-center border-2 border-line bg-card px-4">
        {children}
      </div>
      <h3 className="font-bold">{title}</h3>
      <p className="text-sm leading-relaxed text-muted-foreground">{body}</p>
      <code className="font-mono text-xs text-link">{utility}</code>
    </div>
  );
}

// One component shown twice, in a light and a dark subtree.
function ComponentRow({
  title,
  source,
  children,
}: {
  title: string;
  source: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-xl font-bold">{title}</h3>
        <code className="font-mono text-xs text-muted-foreground">
          {source}
        </code>
      </div>
      <div className="grid border-2 border-line lg:grid-cols-2">
        {(["light", "dark"] as const).map((theme) => (
          <div
            key={theme}
            className={`${theme} flex min-w-0 flex-col items-start gap-4 bg-background p-6 text-foreground`}
          >
            {children}
          </div>
        ))}
      </div>
    </div>
  );
}

function UsageList({
  title,
  tone,
  items,
}: {
  title: string;
  tone: string;
  items: string[];
}) {
  return (
    <div className="border-2 border-line bg-card p-6">
      <h3 className={`mb-3 text-sm font-bold ${tone}`}>{title}</h3>
      <ul className="space-y-2 text-sm leading-relaxed">
        {items.map((item) => (
          <li key={item} className="flex gap-2">
            <span
              aria-hidden="true"
              className="mt-2 size-1.5 shrink-0 bg-foreground"
            />
            {item}
          </li>
        ))}
      </ul>
    </div>
  );
}
