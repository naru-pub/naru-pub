import type { Metadata } from "next";
import Link from "next/link";
import { Bell, BellOff } from "lucide-react";
import { db } from "@/lib/database";
import {
  FAILURE_EVENT_KINDS,
  PAYMENT_EVENT_LABELS,
  type PaymentEventKind,
} from "@/lib/payments/payment-events";
import { isTossLiveMode } from "@/lib/payments/toss";
import { operatorAlertsConfigured } from "@/lib/operator-alerts";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatDate } from "../_components/format";
import { requireOperator } from "../_components/requireOperator";

export const metadata: Metadata = { title: "결제 이벤트 · 운영 · 나루" };

const FAILURE_KINDS = new Set([
  "charge_failed",
  "charge_unresolved",
  "charge_orphaned",
  "past_due",
  "key_deletion_stuck",
  "job_failed",
  "invariant_violation",
]);

export default async function PaymentEventsPage({
  searchParams,
}: {
  searchParams: Promise<{ kind?: string; user?: string; unsent?: string }>;
}) {
  await requireOperator();
  const params = await searchParams;
  const filter =
    params.kind && params.kind in PAYMENT_EVENT_LABELS ? params.kind : null;
  const loginName = params.user?.trim() || null;
  const unsent = params.unsent === "1";

  // Filters combine; each link changes one and keeps the others.
  const href = (
    changes: Partial<{
      kind: string | null;
      user: string | null;
      unsent: boolean;
    }>,
  ) => {
    const next = new URLSearchParams();
    const nextKind = "kind" in changes ? changes.kind : filter;
    const nextUser = "user" in changes ? changes.user : loginName;
    const nextUnsent = "unsent" in changes ? changes.unsent : unsent;
    if (nextKind) next.set("kind", nextKind);
    if (nextUser) next.set("user", nextUser);
    if (nextUnsent) next.set("unsent", "1");
    const query = next.toString();
    return query ? `/admin/events?${query}` : "/admin/events";
  };

  const events = await db
    .selectFrom("payment_events")
    .leftJoin("users", "users.id", "payment_events.user_id")
    .select([
      "payment_events.id",
      "payment_events.created_at",
      "payment_events.kind",
      "payment_events.summary",
      "payment_events.payment_id",
      "payment_events.notified_at",
      "users.login_name",
    ])
    .$if(filter !== null, (qb) => qb.where("payment_events.kind", "=", filter!))
    .$if(loginName !== null, (qb) =>
      qb.where("users.login_name", "=", loginName!),
    )
    .$if(unsent, (qb) => qb.where("payment_events.notified_at", "is", null))
    .orderBy("payment_events.id", "desc")
    .limit(200)
    .execute();

  const configured = operatorAlertsConfigured();
  const live = isTossLiveMode();
  // Posted to Discord: every event in live mode, failures in test mode.
  const notifying = (kind: string) =>
    configured && (live || FAILURE_EVENT_KINDS.has(kind as PaymentEventKind));

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        결제·정기 결제·환불·웹훅이 바꾼 상태를 최근 200건까지 보여 줍니다.{" "}
        {!configured
          ? "Discord 웹훅이 설정되지 않은 환경이라 알리지 않습니다."
          : live
            ? "운영 환경이라 운영자 Discord 채널에 알립니다 — 결제 실패·연체·작업 실패 같은 실패는 1분 안에, 나머지는 2분 동안 새 이벤트가 없을 때(최대 15분) 한 메시지로 묶어서."
            : "테스트 키 환경이라 결제 실패·연체·작업 실패 같은 실패만 운영자 Discord 채널에 1분 안에 알립니다."}
      </p>

      <div className="flex flex-wrap gap-2 text-sm">
        <Link
          href={href({ kind: null })}
          className={filter === null ? "font-bold" : "text-muted-foreground"}
        >
          전체
        </Link>
        {Object.entries(PAYMENT_EVENT_LABELS).map(([key, label]) => (
          <Link
            key={key}
            href={href({ kind: key })}
            className={filter === key ? "font-bold" : "text-muted-foreground"}
          >
            {label}
          </Link>
        ))}
        <span className="text-muted-foreground">|</span>
        <Link
          href={href({ unsent: !unsent })}
          className={unsent ? "font-bold" : "text-muted-foreground"}
        >
          알림 대기만
        </Link>
        {loginName ? (
          <Link href={href({ user: null })} className="font-bold">
            계정 {loginName} ✕
          </Link>
        ) : null}
      </div>

      <div className="overflow-x-auto border-2 border-line bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>시각</TableHead>
              <TableHead>계정</TableHead>
              <TableHead>이벤트</TableHead>
              <TableHead>내용</TableHead>
              <TableHead>알림</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {events.map((event) => (
              <TableRow key={event.id}>
                <TableCell className="whitespace-nowrap">
                  {formatDate(event.created_at)}
                </TableCell>
                <TableCell className="font-medium">
                  {event.login_name ? (
                    <Link
                      href={href({ user: event.login_name })}
                      className="underline"
                    >
                      {event.login_name}
                    </Link>
                  ) : (
                    "-"
                  )}
                </TableCell>
                <TableCell>
                  <Badge
                    variant={
                      FAILURE_KINDS.has(event.kind) ? "destructive" : "outline"
                    }
                    className="whitespace-nowrap"
                  >
                    {PAYMENT_EVENT_LABELS[event.kind as PaymentEventKind] ??
                      event.kind}
                  </Badge>
                </TableCell>
                <TableCell className="max-w-xl break-words">
                  {event.summary}
                </TableCell>
                <TableCell className="whitespace-nowrap text-muted-foreground">
                  {event.notified_at ? (
                    <span
                      className="flex items-center gap-1"
                      title={`알림 ${formatDate(event.notified_at)}`}
                    >
                      <Bell size={14} /> {formatDate(event.notified_at)}
                    </span>
                  ) : (
                    <span className="flex items-center gap-1">
                      <BellOff size={14} />{" "}
                      {notifying(event.kind) ? "대기" : "알리지 않음"}
                    </span>
                  )}
                </TableCell>
              </TableRow>
            ))}
            {events.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={5}
                  className="py-10 text-center text-muted-foreground"
                >
                  이벤트가 없습니다.
                </TableCell>
              </TableRow>
            ) : null}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
