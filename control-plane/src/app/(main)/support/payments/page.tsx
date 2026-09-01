import Link from "next/link";
import { redirect } from "next/navigation";
import { ArrowLeft, ReceiptText } from "lucide-react";

import { validateRequest } from "@/lib/auth";
import { db } from "@/lib/database";
import { SUPPORT_VISIBLE_USERS } from "@/lib/support";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

function formatDate(value: Date | string | null) {
  if (!value) return "-";
  return new Intl.DateTimeFormat("ko-KR", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Seoul",
  }).format(new Date(value));
}

function formatKrw(amount: number) {
  return new Intl.NumberFormat("ko-KR", {
    style: "currency",
    currency: "KRW",
    maximumFractionDigits: 0,
  }).format(amount);
}

function statusLabel(status: string, refundedAmount = 0) {
  switch (status) {
    case "done":
      return "결제 완료";
    case "failed":
      return "결제 실패";
    case "pending":
      return "대기 중";
    case "canceled":
      return refundedAmount > 0 ? "전액 환불" : "결제 취소";
    case "partial_canceled":
      return "부분 환불";
    case "expired":
      return "만료됨";
    default:
      return status;
  }
}

function statusVariant(status: string) {
  if (status === "done") return "secondary" as const;
  if (status === "failed" || status === "aborted" || status === "expired") {
    return "destructive" as const;
  }
  return "outline" as const;
}

function paymentKind(row: {
  subscription_id: number | null;
  attempt_key: string | null;
}) {
  if (row.attempt_key?.startsWith("one_time:")) return "한 번만 후원";
  if (row.attempt_key?.startsWith("subscription_initial:")) {
    return "정기 후원 시작";
  }
  if (row.subscription_id) return "정기 후원 갱신";
  return "후원";
}

export default async function PaymentsPage() {
  const { user } = await validateRequest();

  if (!user) {
    redirect("/");
  }

  if (!SUPPORT_VISIBLE_USERS.has(user.loginName)) {
    redirect("/account");
  }

  const payments = await db
    .selectFrom("payments")
    .select([
      "id",
      "attempt_key",
      "subscription_id",
      "order_id",
      "amount",
      "status",
      "paid_at",
      "period_start",
      "period_end",
      "refunded_amount",
      "refunded_at",
      "created_at",
    ])
    .where("user_id", "=", user.id)
    .where("paid_at", "is not", null)
    .orderBy("created_at", "desc")
    .limit(100)
    .execute();

  return (
    <div className="bg-background min-h-screen">
      <div className="max-w-5xl mx-auto p-6 space-y-6">
        <div className="flex items-center">
          <Button asChild variant="ghost" size="sm">
            <Link href="/support">
              <ArrowLeft size={16} />
              후원으로 돌아가기
            </Link>
          </Button>
        </div>

        <Card className="min-w-0 max-w-full overflow-hidden rounded-none bg-card border-2 border-border shadow-lg">
          <CardHeader className="bg-secondary border-b-2 border-border">
            <CardTitle className="text-foreground text-xl font-bold flex items-center gap-2">
              <ReceiptText size={20} />
              결제 내역
            </CardTitle>
          </CardHeader>
          <CardContent className="min-w-0 max-w-full p-0">
            {payments.length === 0 ? (
              <div className="p-6 text-sm text-muted-foreground">
                아직 결제 내역이 없습니다.
              </div>
            ) : (
              <Table className="table-fixed">
                <TableHeader>
                  <TableRow>
                    <TableHead className="px-2 sm:px-4">일시</TableHead>
                    <TableHead className="hidden px-2 sm:table-cell sm:px-4">
                      종류
                    </TableHead>
                    <TableHead className="px-2 sm:px-4">상태</TableHead>
                    <TableHead className="px-2 text-right sm:px-4">
                      금액
                    </TableHead>
                    <TableHead className="hidden px-2 text-right md:table-cell sm:px-4">
                      환불
                    </TableHead>
                    <TableHead className="hidden px-2 lg:table-cell sm:px-4">
                      이용 기간
                    </TableHead>
                    <TableHead className="hidden px-2 xl:table-cell sm:px-4">
                      주문번호
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {payments.map((payment) => (
                    <TableRow key={payment.id}>
                      <TableCell className="p-2 text-xs sm:p-4 sm:text-sm sm:whitespace-nowrap">
                        {formatDate(payment.paid_at ?? payment.created_at)}
                      </TableCell>
                      <TableCell className="hidden p-2 sm:table-cell sm:p-4">
                        {paymentKind(payment)}
                      </TableCell>
                      <TableCell className="p-2 sm:p-4">
                        <Badge variant={statusVariant(payment.status)}>
                          {statusLabel(payment.status, payment.refunded_amount)}
                        </Badge>
                      </TableCell>
                      <TableCell className="p-2 text-right whitespace-nowrap sm:p-4">
                        {formatKrw(payment.amount)}
                      </TableCell>
                      <TableCell className="hidden p-2 text-right whitespace-nowrap md:table-cell sm:p-4">
                        {payment.refunded_amount > 0
                          ? formatKrw(payment.refunded_amount)
                          : "-"}
                      </TableCell>
                      <TableCell className="hidden p-2 text-muted-foreground lg:table-cell sm:p-4">
                        {payment.period_start && payment.period_end
                          ? `${formatDate(payment.period_start)} - ${formatDate(payment.period_end)}`
                          : "-"}
                      </TableCell>
                      <TableCell className="hidden break-all p-2 font-mono text-xs text-muted-foreground xl:table-cell sm:p-4">
                        {payment.order_id}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
