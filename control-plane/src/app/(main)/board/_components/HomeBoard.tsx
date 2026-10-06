"use client";

import { useId, useState } from "react";
import Link from "next/link";
import { Download, MessageSquare } from "lucide-react";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { POST_KIND_LABELS, type PostKind } from "@/lib/board/constants";
import { Thumbnail } from "./Thumbnail";

// What the front page shows of a post; times are formatted on the server.
export interface HomePost {
  id: string;
  title: string;
  excerpt: string;
  authorLoginName: string;
  time: string;
  replyCount: number;
  applyCount: number | null;
  thumbnailUrl: string | null;
}

// Templates first: they are what the front page is for.
type HomeBoardTab = Exclude<PostKind, "site">;
const TABS: HomeBoardTab[] = ["template", "question", "chat"];

const EMPTY: Record<HomeBoardTab, { text: string; action: string }> = {
  template: {
    text: "아직 공유된 템플릿이나 사이트가 없어요.",
    action: "내 사이트를 첫 템플릿으로 공유해 보세요 →",
  },
  question: { text: "아직 질문이 없어요.", action: "질문하기 →" },
  chat: { text: "아직 글이 없어요.", action: "첫 글 쓰기 →" },
};

// Templates and showcased sites share the first tab.
// All three lists arrive with the page, so switching is instant.
// Templates and showcased sites are pictures in a grid; questions and chat
// are a list.
export function HomeBoard({ posts }: { posts: Record<HomeBoardTab, HomePost[]> }) {
  const [kind, setKind] = useState<HomeBoardTab>("template");
  const id = useId();
  const current = posts[kind];
  const pictures = kind === "template";

  return (
    <Card className="bg-card border-2 border-border shadow-lg min-w-0 flex-1 flex flex-col">
      <CardHeader className="bg-secondary border-b-2 border-border">
        <div className="flex items-center justify-between gap-3">
          <div
            role="tablist"
            aria-label="게시판 글 종류"
            className="-my-1 flex min-w-0 gap-2 overflow-x-auto py-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          >
            {TABS.map((value) => (
              <button
                key={value}
                type="button"
                role="tab"
                id={`${id}-tab-${value}`}
                aria-selected={value === kind}
                aria-controls={`${id}-panel`}
                onClick={() => setKind(value)}
                className={
                  value === kind
                    ? "shrink-0 whitespace-nowrap rounded-full bg-primary px-3 py-1.5 text-sm font-bold text-primary-foreground sm:px-4"
                    : "shrink-0 whitespace-nowrap rounded-full border border-border bg-background px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground sm:px-4"
                }
              >
                {value === "template"
                  ? "템플릿 / 사이트 자랑"
                  : POST_KIND_LABELS[value]}
              </button>
            ))}
          </div>
          <Link
            href={kind === "template" ? "/board" : `/board?kind=${kind}`}
            className="shrink-0 whitespace-nowrap text-primary text-sm font-medium hover:underline"
          >
            더 보기 →
          </Link>
        </div>
      </CardHeader>
      <CardContent
        id={`${id}-panel`}
        role="tabpanel"
        aria-labelledby={`${id}-tab-${kind}`}
        className="p-6 flex-1 flex flex-col"
      >
        {current.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            {EMPTY[kind].text}{" "}
            <Link
              href={`/board/new?kind=${kind}`}
              className="text-primary hover:underline"
            >
              {EMPTY[kind].action}
            </Link>
          </p>
        ) : pictures ? (
          <div className="grid flex-1 grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3 lg:auto-rows-fr">
            {current.map((post) => (
              <article
                key={post.id}
                className="border border-border bg-card flex flex-col"
              >
                <Link
                  href={`/board/${post.id}`}
                  tabIndex={-1}
                  aria-hidden="true"
                  className="block lg:flex-1"
                >
                  <Thumbnail
                    url={post.thumbnailUrl}
                    alt=""
                    className="border-0 border-b"
                    fill
                  />
                </Link>
                <div className="p-3 space-y-1">
                  <Link
                    href={`/board/${post.id}`}
                    className="block truncate font-bold text-foreground hover:text-primary"
                  >
                    {post.title}
                  </Link>
                  <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                    <span className="truncate">{post.authorLoginName}</span>
                    {post.applyCount !== null ? (
                      <span className="flex shrink-0 items-center gap-1 text-primary">
                        <Download size={12} aria-hidden="true" />
                        {post.applyCount}회 적용
                      </span>
                    ) : (
                      <span className="flex shrink-0 items-center gap-1">
                        <MessageSquare size={12} aria-hidden="true" />
                        <span className="sr-only">답글</span>
                        {post.replyCount}
                      </span>
                    )}
                  </div>
                </div>
              </article>
            ))}
          </div>
        ) : (
          <ul className="divide-y divide-border border border-border">
            {current.map((post) => (
              <li key={post.id} className="space-y-1 p-3">
                <Link
                  href={`/board/${post.id}`}
                  className="block truncate font-bold text-foreground hover:text-primary"
                >
                  {post.title}
                </Link>
                {post.excerpt && (
                  <p className="truncate text-sm text-muted-foreground">
                    {post.excerpt}
                  </p>
                )}
                <div className="flex items-center gap-3 text-xs text-muted-foreground">
                  <span className="text-foreground">
                    {post.authorLoginName}
                  </span>
                  <span>{post.time}</span>
                  <span className="flex items-center gap-1">
                    <MessageSquare size={12} aria-hidden="true" />
                    <span className="sr-only">답글</span>
                    {post.replyCount}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
