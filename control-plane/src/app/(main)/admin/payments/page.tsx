import {
  entitlementRepairCandidates,
  entitlementRepairHistory,
} from "@/lib/payments/entitlement-repair";
import { RepairEntitlementButton } from "../_components/RepairEntitlementButton";
import { paymentTaskRecoveryList } from "@/lib/payments/task-recovery";
import type { PaymentJob } from "@/lib/payments/payment-jobs";
import { RetryPaymentTaskButton } from "../_components/RetryPaymentTaskButton";
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

const taskLabels: Record<PaymentJob["kind"], string> = {
  enqueue_due_renewals: "정기 결제 갱신 대상 확인",
  repair_entitlement: "이용 기한 복구",
  confirm_one_time: "한 번만 결제 승인",
  initial_subscription_charge: "정기 결제 첫 청구",
  refund_payment: "환불",
  renew_subscription: "정기 결제 갱신",
  reconcile_payment: "결제 대사",
  thank_you: "첫 결제 안내",
  charge_receipt: "결제 영수증",
  payment_canceled: "환불 안내",
  subscription_canceled: "구독 취소 안내",
  grace_notice: "결제 유예 안내",
  past_due_notice: "연체 안내",
};

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

  const [tasks, repairs, repairHistory] = await Promise.all([
    paymentTaskRecoveryList(),
    entitlementRepairCandidates(now),
    entitlementRepairHistory(),
  ]);

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
      <section className="space-y-3">
        <h2 className="text-lg font-bold">이용 기한 복구</h2>
        <p className="text-sm text-muted-foreground">
          현재 기한과 결제 기록으로 계산한 기한을 확인한 뒤 복구를 요청하세요.
          처리할 때 최신 결제 기록을 다시 확인합니다. 무료 이용 계정과 삭제된
          계정은 제외합니다.
        </p>
        {repairs.length === 0 ? (
          <p className="text-sm">복구가 필요한 계정이 없습니다.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>계정</TableHead>
                <TableHead>현재 기한</TableHead>
                <TableHead>복구 후 기한</TableHead>
                <TableHead>결제 기록</TableHead>
                <TableHead>복구</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {repairs.map((repair) => (
                <TableRow key={repair.userId}>
                  <TableCell>{repair.loginName}</TableCell>
                  <TableCell>{formatDate(repair.beforeUntil)}</TableCell>
                  <TableCell>{formatDate(repair.expectedUntil)}</TableCell>
                  <TableCell>
                    <details>
                      <summary>{repair.payments.length}건</summary>
                      <ul className="space-y-2 text-xs">
                        {repair.payments.map((payment) => (
                          <li key={payment.id}>
                            <div>
                              {payment.orderId} · {formatKrw(payment.amount)}
                              {payment.refunded_amount > 0
                                ? ` · 환불 ${formatKrw(payment.refunded_amount)}`
                                : ""}
                            </div>
                            <div>{payment.id}</div>
                            <div>
                              {formatDate(payment.period_start)} ~{" "}
                              {formatDate(payment.period_end)}
                            </div>
                            {(payment.period_start?.getTime() !==
                              payment.afterStart?.getTime() ||
                              payment.period_end?.getTime() !==
                                payment.afterEnd?.getTime()) && (
                              <div>
                                복구 후: {formatDate(payment.afterStart)} ~{" "}
                                {formatDate(payment.afterEnd)}
                              </div>
                            )}
                            {payment.needsRevocation && (
                              <div>환불에 따른 이용 기한 회수 기록 누락</div>
                            )}
                          </li>
                        ))}
                      </ul>
                    </details>
                  </TableCell>
                  <TableCell>
                    <RepairEntitlementButton userId={repair.userId} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        {repairHistory.length > 0 && (
          <details>
            <summary>최근 복구 요청 {repairHistory.length}건</summary>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>계정 · 상태</TableHead>
                  <TableHead>처리 전 → 후</TableHead>
                  <TableHead>운영자 · 사유</TableHead>
                  <TableHead>요청 시간</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {repairHistory.map((repair) => (
                  <TableRow key={repair.id}>
                    <TableCell>
                      {repair.login_name} ·{" "}
                      {
                        {
                          pending: "대기",
                          completed: "완료",
                          skipped: "건너뜀",
                        }[repair.status]
                      }
                      {repair.result_note && <div>{repair.result_note}</div>}
                    </TableCell>
                    <TableCell>
                      {repair.completed_at
                        ? `${formatDate(repair.before_until)} → ${formatDate(repair.after_until)}`
                        : "처리 대기"}
                    </TableCell>
                    <TableCell>
                      {repair.operator_login_name} · {repair.reason}
                    </TableCell>
                    <TableCell>{formatDate(repair.created_at)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </details>
        )}
      </section>
      <section className="space-y-3">
        <h2 className="text-lg font-bold">결제 작업 복구</h2>
        <p className="text-sm text-muted-foreground">
          실패한 작업을 원래 결제 정보로 다시 시작합니다. 재시도 사유는 운영
          기록에 남습니다.
        </p>
        {tasks.length === 0 ? (
          <p className="text-sm">대기하거나 실패한 작업이 없습니다.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>작업</TableHead>
                <TableHead>상태 · 시도</TableHead>
                <TableHead>최근 오류</TableHead>
                <TableHead>다음 실행</TableHead>
                <TableHead>복구</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {tasks.map((task) => {
                const job = (task.params as { job: PaymentJob }).job;
                const label =
                  (
                    {
                      pending: "대기",
                      running: "처리 중",
                      sleeping: "재시도 대기",
                      failed: "실패",
                    } as Record<string, string>
                  )[task.state] ?? task.state;
                const error = task.last_error as
                  | { message?: string }
                  | string
                  | null;
                return (
                  <TableRow key={task.task_id}>
                    <TableCell>
                      <div>{taskLabels[job.kind]}</div>
                      <div className="text-xs text-muted-foreground">
                        {task.task_id}
                      </div>
                      {"paymentId" in job && (
                        <div className="text-xs">결제 {job.paymentId}</div>
                      )}
                      {job.kind === "repair_entitlement" && (
                        <div className="text-xs">
                          계정 {job.userId} · 복구 {job.repairId}
                        </div>
                      )}
                    </TableCell>
                    <TableCell>
                      {label} · {task.attempts}/{task.max_attempts ?? "∞"}
                    </TableCell>
                    <TableCell className="max-w-sm break-words">
                      {typeof error === "string"
                        ? error
                        : (error?.message ??
                          (error ? JSON.stringify(error) : "—"))}
                    </TableCell>
                    <TableCell>
                      {task.available_at && task.state !== "failed"
                        ? formatDate(task.available_at)
                        : "—"}
                    </TableCell>
                    <TableCell>
                      {task.state === "failed" && (
                        <RetryPaymentTaskButton taskId={task.task_id} />
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </section>

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

      <div className="overflow-x-auto border-2 border-line bg-card">
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
