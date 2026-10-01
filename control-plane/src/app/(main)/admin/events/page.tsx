import type { Metadata } from "next";
import Link from "next/link";
import { Mail, MailX } from "lucide-react";
import { db } from "@/lib/database";
import {
  PAYMENT_EVENT_LABELS,
  PAYMENT_EVENTS_EMAIL,
  type PaymentEventKind,
} from "@/lib/payment-events";
import { isTossLiveMode } from "@/lib/toss";
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
  "past_due",
  "key_deletion_stuck",
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
      "payment_events.emailed_at",
      "users.login_name",
    ])
    .$if(filter !== null, (qb) => qb.where("payment_events.kind", "=", filter!))
    .$if(loginName !== null, (qb) =>
      qb.where("users.login_name", "=", loginName!),
    )
    .$if(unsent, (qb) => qb.where("payment_events.emailed_at", "is", null))
    .orderBy("payment_events.id", "desc")
    .limit(200)
    .execute();

  const mailing = isTossLiveMode();

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        결제·정기 결제·환불·웹훅이 바꾼 상태를 최근 200건까지 보여 줍니다.{" "}
        {mailing
          ? `운영 환경이라 ${PAYMENT_EVENTS_EMAIL}로 메일을 보냅니다 — 이어서 일어난 이벤트는 2분 동안 새 이벤트가 없을 때(최대 15분) 한 통으로 묶습니다.`
          : "Toss 라이브 키가 아닌 환경이라 메일은 보내지 않습니다."}
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
          메일 대기만
        </Link>
        {loginName ? (
          <Link href={href({ user: null })} className="font-bold">
            계정 {loginName} ✕
          </Link>
        ) : null}
      </div>

      <div className="overflow-x-auto border-2 border-border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>시각</TableHead>
              <TableHead>계정</TableHead>
              <TableHead>이벤트</TableHead>
              <TableHead>내용</TableHead>
              <TableHead>메일</TableHead>
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
                  {event.emailed_at ? (
                    <span
                      className="flex items-center gap-1"
                      title={`발송 ${formatDate(event.emailed_at)}`}
                    >
                      <Mail size={14} /> {formatDate(event.emailed_at)}
                    </span>
                  ) : (
                    <span className="flex items-center gap-1">
                      <MailX size={14} /> {mailing ? "대기" : "보내지 않음"}
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
