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
  searchParams: Promise<{ kind?: string }>;
}) {
  await requireOperator();
  const { kind } = await searchParams;
  const filter = kind && kind in PAYMENT_EVENT_LABELS ? kind : null;

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
          href="/admin/events"
          className={filter === null ? "font-bold" : "text-muted-foreground"}
        >
          전체
        </Link>
        {Object.entries(PAYMENT_EVENT_LABELS).map(([key, label]) => (
          <Link
            key={key}
            href={`/admin/events?kind=${key}`}
            className={filter === key ? "font-bold" : "text-muted-foreground"}
          >
            {label}
          </Link>
        ))}
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
                  {event.login_name ?? "-"}
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
