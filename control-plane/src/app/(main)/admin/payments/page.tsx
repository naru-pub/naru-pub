import type { Metadata } from "next";
import Link from "next/link";
import { sql } from "kysely";
import { AlertTriangle, RefreshCw } from "lucide-react";
import { db } from "@/lib/database";
import { RefundPaymentButton } from "@/components/RefundPaymentButton";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatDate, formatKrw } from "../_components/format";
import {
  isPaymentFilter,
  PAYMENT_FILTERS,
  type PaymentFilterKey,
} from "../_components/metrics";
import { ReconcilePaymentButton } from "../_components/ReconcilePaymentButton";
import { RecoverChargeButton } from "../_components/RecoverChargeButton";
import { RECOVERABLE_STATUSES } from "@/lib/payments/payment-reconciliation";
import { requireOperator } from "../_components/requireOperator";

export const metadata: Metadata = { title: "결제 · 운영 · 나루" };

export default async function PaymentOperatorPage({
  searchParams,
}: {
  searchParams: Promise<{ filter?: string }>;
}) {
  await requireOperator();
  const { filter: filterParam } = await searchParams;
  const filter = isPaymentFilter(filterParam) ? filterParam : null;
  const now = new Date();
  const condition = filter ? PAYMENT_FILTERS[filter].condition(now) : null;

  // Counted over every payment, not only the rows listed below.
  const counts = await db
    .selectFrom("payments")
    .select(
      (Object.keys(PAYMENT_FILTERS) as PaymentFilterKey[]).map((key) =>
        sql<number>`count(*) filter (where ${PAYMENT_FILTERS[key].condition(now)})::int`.as(
          key,
        ),
      ),
    )
    .executeTakeFirstOrThrow();
  const totals = await db
    .selectFrom("payments")
    .select([
      sql<number>`count(*)::int`.as("count"),
      sql<number>`coalesce(sum(payments.amount), 0)::int`.as("amount"),
      sql<number>`coalesce(sum(payments.refunded_amount), 0)::int`.as(
        "refunded",
      ),
    ])
    .$if(condition !== null, (qb) => qb.where(condition!))
    .executeTakeFirstOrThrow();

  const payments = await db
    .selectFrom("payments")
    .innerJoin("users", "users.id", "payments.user_id")
    .leftJoin("subscriptions", "subscriptions.id", "payments.subscription_id")
    .select([
      "payments.id",
      "payments.user_id",
      "payments.order_id",
      "payments.paid_at",
      "payments.amount",
      "payments.status",
      "payments.refunded_amount",
      "payments.refund_requested_at",
      "payments.created_at",
      "payments.last_reconciled_at",
      "payments.reconciliation_error",
      "users.login_name",
      "subscriptions.status as subscription_status",
    ])
    .$if(condition !== null, (qb) => qb.where(condition!))
    .orderBy("payments.created_at", "desc")
    .limit(200)
    .execute();

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap gap-2 text-sm">
        <Link
          href="/admin/payments"
          className={`border-2 px-3 py-1 ${filter === null ? "border-primary font-bold" : "border-border text-muted-foreground"}`}
        >
          전체
        </Link>
        {(Object.keys(PAYMENT_FILTERS) as PaymentFilterKey[]).map((key) => (
          <Link
            key={key}
            href={`/admin/payments?filter=${key}`}
            className={`border-2 px-3 py-1 ${filter === key ? "border-primary font-bold" : "border-border text-muted-foreground"}`}
          >
            {PAYMENT_FILTERS[key].label} {counts[key]}
          </Link>
        ))}
      </div>

      <div className="space-y-1">
        <h2 className="text-xl font-bold">
          {filter ? PAYMENT_FILTERS[filter].label : "전체 결제"}
        </h2>
        <p className="text-sm text-muted-foreground">
          {filter
            ? PAYMENT_FILTERS[filter].description
            : "모든 결제 기록과 Toss 대사 상태입니다."}{" "}
          {totals.count}건 · 결제 {formatKrw(totals.amount)} · 환불{" "}
          {formatKrw(totals.refunded)}
          {totals.count > payments.length
            ? ` · 최근 ${payments.length}건만 표시`
            : ""}
        </p>
      </div>

      <div className="overflow-x-auto border-2 border-border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>사용자</TableHead>
              <TableHead>생성</TableHead>
              <TableHead>상태</TableHead>
              <TableHead>구독</TableHead>
              <TableHead className="text-right">결제</TableHead>
              <TableHead className="text-right">환불</TableHead>
              <TableHead>마지막 확인</TableHead>
              <TableHead>진단</TableHead>
              <TableHead>작업</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {payments.map((payment) => (
              <TableRow key={payment.id}>
                <TableCell className="font-medium">
                  {payment.login_name}
                </TableCell>
                <TableCell className="whitespace-nowrap">
                  {formatDate(payment.created_at)}
                </TableCell>
                <TableCell>
                  <Badge variant="outline">{payment.status}</Badge>
                </TableCell>
                <TableCell>{payment.subscription_status ?? "-"}</TableCell>
                <TableCell className="text-right whitespace-nowrap">
                  {formatKrw(payment.amount)}
                </TableCell>
                <TableCell className="text-right whitespace-nowrap">
                  {payment.refunded_amount
                    ? formatKrw(payment.refunded_amount)
                    : "-"}
                </TableCell>
                <TableCell className="whitespace-nowrap">
                  {formatDate(payment.last_reconciled_at)}
                </TableCell>
                <TableCell className="max-w-72">
                  {payment.reconciliation_error ? (
                    <span className="flex items-start gap-1 text-sm text-destructive">
                      <AlertTriangle size={15} className="mt-0.5 shrink-0" />
                      <span className="break-words">
                        {payment.reconciliation_error}
                      </span>
                    </span>
                  ) : (
                    <span className="text-muted-foreground">-</span>
                  )}
                </TableCell>
                <TableCell>
                  <div className="flex flex-wrap gap-2">
                    <ReconcilePaymentButton paymentId={payment.id} />
                    {RECOVERABLE_STATUSES.includes(payment.status) ? (
                      <RecoverChargeButton paymentId={payment.id} />
                    ) : null}
                    {(payment.status === "done" ||
                      payment.refund_requested_at) &&
                    !payment.refunded_amount ? (
                      <RefundPaymentButton
                        paymentId={payment.id}
                        requested={payment.refund_requested_at != null}
                        confirmMessage={`${payment.login_name}님의 ${formatKrw(payment.amount)} 결제를 전액 환불할까요? 환불이 완료되면 유료 기능이 종료되고, 정기 결제 중이라면 자동 결제도 함께 취소됩니다.`}
                      />
                    ) : null}
                  </div>
                </TableCell>
              </TableRow>
            ))}
            {payments.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={9}
                  className="py-10 text-center text-muted-foreground"
                >
                  결제 내역이 없습니다.
                </TableCell>
              </TableRow>
            ) : null}
          </TableBody>
        </Table>
      </div>

      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <RefreshCw size={14} />
        대기 결제는 5분마다, 환불은 웹훅과 매일 대사합니다. 방문자 현황 조회는
        환불 조건을 없애지 않습니다. 환불은 운영자 판단으로 기간이나 사용 여부와
        관계없이 실행할 수 있습니다.
      </p>
    </div>
  );
}
