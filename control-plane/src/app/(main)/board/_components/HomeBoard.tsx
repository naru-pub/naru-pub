"use client";

import { useState } from "react";
import Link from "next/link";
import { Download, MessageSquare } from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { POST_KIND_LABELS, type PostKind } from "@/lib/board/constants";
import { PostTitle } from "./PostTitle";
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

  return (
    <section className="min-w-0 flex-1 flex flex-col border-2 border-line bg-card">
      <Tabs
        value={kind}
        onValueChange={(value) => setKind(value as HomeBoardTab)}
        className="flex flex-1 flex-col"
      >
        <div className="flex items-end justify-between gap-3 border-b border-border px-2 sm:px-4">
          <TabsList aria-label="게시판 글 종류" className="border-b-0">
            {TABS.map((value) => (
              <TabsTrigger key={value} value={value}>
                {value === "template"
                  ? "템플릿 / 사이트 자랑"
                  : POST_KIND_LABELS[value]}
              </TabsTrigger>
            ))}
          </TabsList>
          <Link
            href={kind === "template" ? "/board" : `/board?kind=${kind}`}
            className="mb-3 shrink-0 whitespace-nowrap text-sm font-medium text-link underline-offset-4 hover:underline"
          >
            더 보기 →
          </Link>
        </div>
        {TABS.map((value) => (
          <TabsContent
            key={value}
            value={value}
            className="p-4 sm:p-6 flex-1 flex flex-col"
          >
            <TabPosts kind={value} posts={posts[value]} />
          </TabsContent>
        ))}
      </Tabs>
    </section>
  );
}

function TabPosts({ kind, posts }: { kind: HomeBoardTab; posts: HomePost[] }) {
  if (posts.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 py-10 text-center">
        <p className="text-muted-foreground">{EMPTY[kind].text}</p>
        <Link
          href={`/board/new?kind=${kind}`}
          className="text-sm font-medium text-link underline-offset-4 hover:underline"
        >
          {EMPTY[kind].action}
        </Link>
      </div>
    );
  }
  if (kind === "template") {
    return (
      <div className="grid flex-1 grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3 lg:auto-rows-fr">
        {posts.map((post) => (
          <article
            key={post.id}
            className="lift relative border-2 border-line bg-card flex flex-col"
          >
            <Thumbnail
              url={post.thumbnailUrl}
              alt=""
              className="border-0 border-b-2 border-b-line lg:flex-1"
              fill
            />
            <div className="p-3 space-y-1">
              {/* The title's link covers the whole card. */}
              <Link
                href={`/board/${post.id}`}
                className="block truncate font-bold text-foreground after:absolute after:inset-0"
              >
                <PostTitle title={post.title} />
              </Link>
              <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                <span className="truncate font-mono">{post.authorLoginName}</span>
                {post.applyCount !== null ? (
                  <span className="flex shrink-0 items-center gap-1 font-semibold text-link">
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
    );
  }
  return (
    <ul className="divide-y divide-border border-2 border-line">
      {posts.map((post) => (
        <li key={post.id} className="relative space-y-1 p-4 hover:bg-accent">
          <Link
            href={`/board/${post.id}`}
            className="block truncate font-bold text-foreground after:absolute after:inset-0"
          >
            <PostTitle title={post.title} />
          </Link>
          {post.excerpt && (
            <p className="truncate text-sm text-muted-foreground">
              {post.excerpt}
            </p>
          )}
          <div className="flex items-center gap-3 text-xs text-muted-foreground">
            <span className="font-mono font-medium text-foreground">
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
  );
}
