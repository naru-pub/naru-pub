import type { Metadata } from "next";
import Link from "next/link";
import { sql } from "kysely";
import { db } from "@/lib/database";
import {
  PAYMENT_EVENT_LABELS,
  PAYMENT_EVENTS_EMAIL,
  type PaymentEventKind,
} from "@/lib/payment-events";
import { isTossLiveMode, isTossTestMode } from "@/lib/toss";
import { Badge } from "@/components/ui/badge";
import { formatDate, formatKrw } from "./_components/format";
import { requireOperator } from "./_components/requireOperator";

export const metadata: Metadata = { title: "운영 · 나루" };

const DAY_MS = 24 * 60 * 60 * 1000;

function Stat({
  label,
  value,
  detail,
  href,
  alert = false,
}: {
  label: string;
  value: string | number;
  detail?: string;
  href: string;
  alert?: boolean;
}) {
  return (
    <Link
      href={href}
      className={`block border-2 bg-card p-4 hover:border-primary ${alert ? "border-destructive" : "border-border"}`}
    >
      <div className="text-sm text-muted-foreground">{label}</div>
      <div className={`text-2xl font-bold ${alert ? "text-destructive" : ""}`}>
        {value}
      </div>
      {detail ? (
        <div className="text-xs text-muted-foreground">{detail}</div>
      ) : null}
    </Link>
  );
}

export default async function AdminOverviewPage() {
  await requireOperator();
  const now = Date.now();
  const weekAgo = new Date(now - 7 * DAY_MS);
  const monthAgo = new Date(now - 30 * DAY_MS);
  const dayAgo = new Date(now - DAY_MS);

  const [
    payments,
    subscriptions,
    supporters,
    webhooks,
    events,
    keys,
    recentEvents,
    recentDeliveries,
  ] = await Promise.all([
    db
      .selectFrom("payments")
      .select([
        sql<number>`count(*) filter (where status = 'pending')::int`.as(
          "pending",
        ),
        sql<number>`count(*) filter (where reconciliation_error is not null and status in ('pending', 'done'))::int`.as(
          "errors",
        ),
        sql<number>`count(*) filter (where status in ('failed', 'aborted') and created_at >= ${weekAgo})::int`.as(
          "failedWeek",
        ),
        sql<number>`count(*) filter (where status = 'done' and paid_at >= ${monthAgo})::int`.as(
          "paidMonth",
        ),
        sql<number>`coalesce(sum(amount) filter (where status = 'done' and paid_at >= ${monthAgo}), 0)::int`.as(
          "paidMonthAmount",
        ),
        sql<number>`coalesce(sum(refunded_amount) filter (where refunded_at >= ${monthAgo}), 0)::int`.as(
          "refundedMonthAmount",
        ),
      ])
      .executeTakeFirstOrThrow(),
    db
      .selectFrom("subscriptions")
      .select(["status", sql<number>`count(*)::int`.as("count")])
      .groupBy("status")
      .execute(),
    db
      .selectFrom("users")
      .select(
        sql<number>`count(*) filter (where supporter_comp or supporter_until > now())::int`.as(
          "count",
        ),
      )
      .executeTakeFirstOrThrow(),
    db
      .selectFrom("toss_webhook_deliveries")
      .select([
        sql<number>`count(*) filter (where received_at >= ${dayAgo})::int`.as(
          "day",
        ),
        sql<number>`count(*) filter (where received_at >= ${weekAgo} and http_status >= 500)::int`.as(
          "failedWeek",
        ),
        sql<Date | null>`max(received_at)`.as("last"),
      ])
      .executeTakeFirstOrThrow(),
    db
      .selectFrom("payment_events")
      .select([
        sql<number>`count(*) filter (where emailed_at is null and created_at >= ${weekAgo})::int`.as(
          "unsent",
        ),
        sql<Date | null>`max(emailed_at)`.as("lastEmailed"),
      ])
      .executeTakeFirstOrThrow(),
    db
      .selectFrom("retired_billing_keys")
      .select([
        sql<number>`count(*)::int`.as("queued"),
        sql<number>`count(*) filter (where attempts >= 5)::int`.as("stuck"),
      ])
      .executeTakeFirstOrThrow(),
    db
      .selectFrom("payment_events")
      .leftJoin("users", "users.id", "payment_events.user_id")
      .select([
        "payment_events.id",
        "payment_events.created_at",
        "payment_events.kind",
        "payment_events.summary",
        "users.login_name",
      ])
      .orderBy("payment_events.id", "desc")
      .limit(8)
      .execute(),
    db
      .selectFrom("toss_webhook_deliveries")
      .select([
        "id",
        "received_at",
        "event_type",
        "subject",
        "outcome",
        "http_status",
      ])
      .orderBy("id", "desc")
      .limit(5)
      .execute(),
  ]);

  const byStatus = new Map(
    subscriptions.map((row) => [row.status, Number(row.count)]),
  );
  const live = isTossLiveMode();
  const mode = live ? "라이브" : isTossTestMode() ? "테스트" : "미설정";

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
        <Badge variant={live ? "default" : "outline"}>Toss {mode} 키</Badge>
        {live
          ? `결제 이벤트는 ${PAYMENT_EVENTS_EMAIL}로 메일을 보냅니다${events.lastEmailed ? ` (마지막 ${formatDate(events.lastEmailed)})` : ""}.`
          : "이 환경에서는 결제 이벤트 메일을 보내지 않습니다."}
      </div>

      <section className="space-y-2">
        <h2 className="font-semibold">결제</h2>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Stat
            label="최근 30일 결제"
            value={formatKrw(payments.paidMonthAmount)}
            detail={`${payments.paidMonth}건 · 환불 ${formatKrw(payments.refundedMonthAmount)}`}
            href="/admin/payments"
          />
          <Stat
            label="대기 중"
            value={payments.pending}
            detail="5분마다 Toss와 대사"
            href="/admin/payments"
          />
          <Stat
            label="대사 오류"
            value={payments.errors}
            href="/admin/payments"
            alert={payments.errors > 0}
          />
          <Stat
            label="최근 7일 실패"
            value={payments.failedWeek}
            detail="거절·실패한 주문"
            href="/admin/events?kind=charge_failed"
          />
        </div>
      </section>

      <section className="space-y-2">
        <h2 className="font-semibold">정기 결제와 이용</h2>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Stat
            label="유료 이용 중"
            value={supporters.count}
            detail="무료 제공 포함"
            href="/admin/payments"
          />
          <Stat
            label="정기 결제"
            value={byStatus.get("active") ?? 0}
            detail={`예약 ${byStatus.get("scheduled") ?? 0} · 가입 중 ${byStatus.get("incomplete") ?? 0}`}
            href="/admin/payments"
          />
          <Stat
            label="연체(past_due)"
            value={byStatus.get("past_due") ?? 0}
            href="/admin/events?kind=past_due"
            alert={(byStatus.get("past_due") ?? 0) > 0}
          />
          <Stat
            label="빌링키 삭제 대기"
            value={keys.queued}
            detail={keys.stuck ? `${keys.stuck}개는 5번 넘게 실패` : undefined}
            href="/admin/events?kind=key_deletion_stuck"
            alert={keys.stuck > 0}
          />
        </div>
      </section>

      <section className="space-y-2">
        <h2 className="font-semibold">웹훅과 알림</h2>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Stat
            label="최근 24시간 웹훅"
            value={webhooks.day}
            detail={
              webhooks.last
                ? `마지막 ${formatDate(webhooks.last)}`
                : "받은 적 없음"
            }
            href="/admin/webhooks"
          />
          <Stat
            label="최근 7일 재시도 요청"
            value={webhooks.failedWeek}
            detail="5xx로 답한 웹훅"
            href="/admin/webhooks?failed=1"
            alert={webhooks.failedWeek > 0}
          />
          <Stat
            label="메일 대기 중 이벤트"
            value={live ? events.unsent : "-"}
            detail={live ? "몇 분 안에 한 통으로 발송" : "운영 환경에서만 발송"}
            href="/admin/events"
          />
        </div>
      </section>

      <div className="grid gap-6 lg:grid-cols-2">
        <section className="space-y-2">
          <div className="flex items-baseline justify-between">
            <h2 className="font-semibold">최근 결제 이벤트</h2>
            <Link href="/admin/events" className="text-sm underline">
              전체 보기
            </Link>
          </div>
          <ul className="divide-y-2 divide-border border-2 border-border bg-card text-sm">
            {recentEvents.map((event) => (
              <li key={event.id} className="space-y-0.5 p-3">
                <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  <span>{formatDate(event.created_at)}</span>
                  <span className="font-medium text-foreground">
                    {event.login_name ?? "-"}
                  </span>
                  <Badge variant="outline">
                    {PAYMENT_EVENT_LABELS[event.kind as PaymentEventKind] ??
                      event.kind}
                  </Badge>
                </div>
                <div className="break-words">{event.summary}</div>
              </li>
            ))}
            {recentEvents.length === 0 ? (
              <li className="p-3 text-muted-foreground">이벤트가 없습니다.</li>
            ) : null}
          </ul>
        </section>

        <section className="space-y-2">
          <div className="flex items-baseline justify-between">
            <h2 className="font-semibold">최근 웹훅</h2>
            <Link href="/admin/webhooks" className="text-sm underline">
              전체 보기
            </Link>
          </div>
          <ul className="divide-y-2 divide-border border-2 border-border bg-card text-sm">
            {recentDeliveries.map((delivery) => (
              <li key={delivery.id} className="space-y-0.5 p-3">
                <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  <span>{formatDate(delivery.received_at)}</span>
                  <span className="font-medium text-foreground">
                    {delivery.event_type}
                  </span>
                  <Badge
                    variant={
                      delivery.http_status >= 500 ? "destructive" : "secondary"
                    }
                  >
                    {delivery.http_status}
                  </Badge>
                  {delivery.subject ? (
                    <span className="font-mono">{delivery.subject}</span>
                  ) : null}
                </div>
                <div className="break-words">{delivery.outcome}</div>
              </li>
            ))}
            {recentDeliveries.length === 0 ? (
              <li className="p-3 text-muted-foreground">
                받은 웹훅이 없습니다.
              </li>
            ) : null}
          </ul>
        </section>
      </div>
    </div>
  );
}
