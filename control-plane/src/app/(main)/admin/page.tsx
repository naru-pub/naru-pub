import Link from "next/link";
import { redirect } from "next/navigation";
import { AlertTriangle, ArrowLeft, RefreshCw } from "lucide-react";
import { validateRequest } from "@/lib/auth";
import { db } from "@/lib/database";
import { PAYMENT_OPERATOR_USERS } from "@/lib/support";
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
      "payments.order_id",
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
                    <ReconcilePaymentButton paymentId={payment.id} />
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
          대기 결제는 5분마다, 환불은 웹훅과 매일 대사합니다.
        </p>
      </div>
    </div>
  );
}
