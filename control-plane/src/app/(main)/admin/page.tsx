import Link from "next/link";
import { redirect } from "next/navigation";
import { AlertTriangle, ArrowLeft, RefreshCw } from "lucide-react";
import { validateRequest } from "@/lib/auth";
import { db } from "@/lib/database";
import { FEATURE_LABELS } from "@/lib/entitlements";
import { getSupporterFeatureUsesForUsers } from "@/lib/feature-usage";
import { blocksRefund } from "@/lib/refunds";
import { PAYMENT_OPERATOR_USERS } from "@/lib/support";
import { RefundPaymentButton } from "@/components/RefundPaymentButton";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ReconcilePaymentButton } from "./ReconcilePaymentButton";

function formatDate(value: Date | string | null) {
  if (!value) return "-";
  return new Intl.DateTimeFormat("ko-KR", {
    dateStyle: "short",
    timeStyle: "short",
    timeZone: "Asia/Seoul",
  }).format(new Date(value));
}

function formatKrw(amount: number) {
  return new Intl.NumberFormat("ko-KR").format(amount) + "원";
}

export default async function PaymentOperatorPage() {
  const { user } = await validateRequest();
  if (!user || !PAYMENT_OPERATOR_USERS.has(user.loginName)) {
    redirect("/account");
  }

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
      "payments.created_at",
      "payments.last_reconciled_at",
      "payments.reconciliation_error",
      "users.login_name",
      "subscriptions.status as subscription_status",
    ])
    .orderBy("payments.created_at", "desc")
    .limit(200)
    .execute();

  // 환불 판단에는 "결제 뒤에 후원자 전용 기능을 썼는가"가 필요하다. 결제마다
  // 따로 조회하지 않고 이 목록에 등장하는 계정의 사용 기록을 한 번에 읽는다.
  const featureUses = await getSupporterFeatureUsesForUsers(
    payments.map((payment) => payment.user_id),
  );

  const pending = payments.filter((payment) => payment.status === "pending");
  const errors = payments.filter((payment) => payment.reconciliation_error);
  const failed = payments.filter((payment) =>
    ["failed", "aborted", "expired"].includes(payment.status),
  );

  return (
    <div className="min-h-screen bg-background">
      <div className="mx-auto max-w-7xl space-y-6 p-6">
        <div className="flex items-center justify-between">
          <div>
            <Button asChild variant="ghost" size="sm">
              <Link href="/support/payments">
                <ArrowLeft size={16} />내 결제 내역
              </Link>
            </Button>
            <h1 className="mt-3 text-2xl font-bold">결제 운영</h1>
            <p className="text-sm text-muted-foreground">
              최근 결제 200건과 Toss 대사 상태입니다.
            </p>
          </div>
        </div>

        <div className="grid gap-3 sm:grid-cols-3">
          <div className="border-2 border-border bg-card p-4">
            <div className="text-sm text-muted-foreground">대기 중</div>
            <div className="text-2xl font-bold">{pending.length}</div>
          </div>
          <div className="border-2 border-border bg-card p-4">
            <div className="text-sm text-muted-foreground">대사 오류</div>
            <div className="text-2xl font-bold">{errors.length}</div>
          </div>
          <div className="border-2 border-border bg-card p-4">
            <div className="text-sm text-muted-foreground">실패/만료</div>
            <div className="text-2xl font-bold">{failed.length}</div>
          </div>
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
                <TableHead>기능 사용</TableHead>
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
                  <TableCell className="max-w-56">
                    {(() => {
                      const uses = featureUses.get(payment.user_id) ?? [];
                      if (uses.length === 0) {
                        return (
                          <span className="text-muted-foreground">
                            기록 없음
                          </span>
                        );
                      }
                      const paidAt = payment.paid_at
                        ? new Date(payment.paid_at).getTime()
                        : null;
                      const since =
                        paidAt === null
                          ? []
                          : uses.filter(
                              (use) => use.lastUsedAt.getTime() >= paidAt,
                            );
                      if (since.length === 0) {
                        return (
                          <span className="text-sm text-muted-foreground">
                            결제 후 미사용 (마지막{" "}
                            {formatDate(uses[0].lastUsedAt)})
                          </span>
                        );
                      }
                      // 방문자 현황만 열어본 계정은 환불 조건이 그대로
                      // 남는다. 운영자가 목록만 보고 "썼으니 환불 불가"로
                      // 읽지 않도록 조건을 없애는 사용과 나눠서 적는다.
                      const blocking = since.filter((use) =>
                        blocksRefund(use.feature),
                      );
                      const label = (use: (typeof since)[number]) =>
                        FEATURE_LABELS[use.feature] ?? use.feature;
                      return (
                        <span className="text-sm break-words">
                          <span
                            className={
                              blocking.length
                                ? undefined
                                : "text-muted-foreground"
                            }
                          >
                            {since.map(label).join(", ")}
                          </span>
                          <span className="block text-xs text-muted-foreground">
                            마지막 {formatDate(since[0].lastUsedAt)}
                            {blocking.length ? null : " · 환불 조건 유지"}
                          </span>
                        </span>
                      );
                    })()}
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
                      {payment.status === "done" && !payment.refunded_amount ? (
                        <RefundPaymentButton
                          paymentId={payment.id}
                          confirmMessage={`${payment.login_name}님의 ${formatKrw(payment.amount)} 결제를 전액 환불할까요? 후원자 전용 기능이 즉시 종료되고, 정기 후원 중이라면 자동 결제도 함께 취소됩니다.`}
                        />
                      ) : null}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
              {payments.length === 0 ? (
                <TableRow>
                  <TableCell
                    colSpan={10}
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
          환불 조건을 없애지 않습니다. 환불은 운영자 판단으로 기간이나 사용
          여부와 관계없이 실행할 수 있습니다.
        </p>
      </div>
    </div>
  );
}
