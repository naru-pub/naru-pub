import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { validateRequest } from "@/lib/auth";
import { listNotifications } from "@/lib/board/replies";
import { formatRelative } from "../_components/format";
import { MarkAllReadButton } from "./MarkAllReadButton";

export const metadata: Metadata = { title: "알림 · 나루 게시판" };

export default async function NotificationsPage() {
  const { user } = await validateRequest();
  if (!user) redirect("/login");
  const notifications = await listNotifications(user.id);
  const unread = notifications.filter((n) => !n.read).length;

  return (
    <div className="bg-background min-h-screen p-4 sm:p-6">
      <main className="mx-auto max-w-3xl space-y-6">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="space-y-1">
            <Link
              href="/board"
              className="text-xs text-primary hover:underline"
            >
              ← 게시판
            </Link>
            <h1 className="text-2xl font-bold">알림</h1>
          </div>
          {unread > 0 && <MarkAllReadButton />}
        </div>
        {notifications.length === 0 ? (
          <p className="border-2 border-line p-8 text-center text-sm text-muted-foreground">
            아직 알림이 없어요.
          </p>
        ) : (
          <ul className="border-2 border-line bg-card">
            {notifications.map((n) => (
              <li
                key={n.id}
                className={`border-b border-border last:border-b-0 ${n.read ? "" : "bg-primary/5"}`}
              >
                <Link
                  href={`/board/${n.postId}#reply-${n.replyId}`}
                  className="block space-y-1 p-4 hover:bg-accent"
                >
                  <span className="block text-sm">
                    {!n.read && (
                      <span
                        className="mr-2 inline-block h-2 w-2 bg-primary"
                        aria-label="읽지 않음"
                      />
                    )}
                    <strong>{n.fromLoginName}</strong> 님이{" "}
                    {n.reason === "reply_to_reply" ? "내 답글에" : "내 글"}{" "}
                    {n.reason === "reply_to_reply"
                      ? "답글을 달았어요"
                      : `「${n.postTitle}」에 답글을 달았어요`}
                  </span>
                  <span className="block truncate text-sm text-muted-foreground">
                    {n.replyExcerpt}
                  </span>
                  <span className="block text-xs text-muted-foreground">
                    {formatRelative(n.createdAt)}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </main>
    </div>
  );
}
