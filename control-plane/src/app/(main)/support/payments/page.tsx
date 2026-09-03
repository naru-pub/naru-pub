import { Fragment } from "react";
import Link from "next/link";
import { redirect } from "next/navigation";
import { ArrowLeft, ReceiptText } from "lucide-react";

import { validateRequest } from "@/lib/auth";
import { db } from "@/lib/database";
import { getSupporterFeatureUses } from "@/lib/feature-usage";
import { refundEligibility, REFUND_WINDOW_DAYS } from "@/lib/refunds";
import { RefundPaymentButton } from "@/components/RefundPaymentButton";
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

// 환불 신청을 받지 못하는 사유는 버튼 자리에 그대로 적어 준다. 왜 안 되는지
// 모른 채 메일을 보내게 만들지 않기 위해서다.
function refundBlockedLabel(reason: string) {
  switch (reason) {
    case "already_refunded":
      return "환불 완료";
    case "window_passed":
      return `${REFUND_WINDOW_DAYS}일 경과`;
    case "feature_used":
      return "기능 사용함";
    default:
      return "-";
  }
}

export default async function PaymentsPage() {
  const { user } = await validateRequest();

  if (!user) {
    redirect("/");
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

  const featureUses = await getSupporterFeatureUses(user.id);
  const now = new Date();
  const refundState = new Map(
    payments.map((payment) => [
      payment.id,
      refundEligibility({
        status: payment.status,
        paidAt: payment.paid_at,
        refundedAmount: payment.refunded_amount,
        featureUses,
        now,
      }),
    ]),
  );

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
              // 결제 하나를 두 줄로 나눈다. 첫 줄은 한눈에 봐야 하는
              // 것들(일시·종류·상태·금액·환불 신청), 둘째 줄은 필요할 때만 읽는
              // 것들(이용 기간·환불액·주문번호). 좁은 화면에서 열을 숨기던
              // 방식은 정작 주문번호처럼 문의할 때 필요한 값을 보이지 않게
              // 만들어서, 열을 줄이고 줄을 늘리는 쪽으로 바꿨다.
              <Table className="table-auto">
                <TableHeader>
                  <TableRow>
                    <TableHead className="px-3 sm:px-4">결제</TableHead>
                    <TableHead className="px-3 sm:px-4">상태</TableHead>
                    <TableHead className="px-3 text-right sm:px-4">
                      금액
                    </TableHead>
                    <TableHead className="px-3 text-right sm:px-4">
                      환불 신청
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {payments.map((payment) => {
                    const state = refundState.get(payment.id);
                    return (
                      <Fragment key={payment.id}>
                        <TableRow className="border-b-0 hover:bg-transparent">
                          <TableCell className="px-3 pt-3 pb-1 align-top sm:px-4">
                            <div className="text-sm whitespace-nowrap">
                              {formatDate(
                                payment.paid_at ?? payment.created_at,
                              )}
                            </div>
                            <div className="text-xs text-muted-foreground">
                              {paymentKind(payment)}
                            </div>
                          </TableCell>
                          <TableCell className="px-3 pt-3 pb-1 align-top sm:px-4">
                            <Badge variant={statusVariant(payment.status)}>
                              {statusLabel(
                                payment.status,
                                payment.refunded_amount,
                              )}
                            </Badge>
                          </TableCell>
                          <TableCell className="px-3 pt-3 pb-1 text-right align-top whitespace-nowrap sm:px-4">
                            {formatKrw(payment.amount)}
                          </TableCell>
                          <TableCell className="px-3 pt-3 pb-1 text-right align-top sm:px-4">
                            {state?.eligible ? (
                              <RefundPaymentButton
                                paymentId={payment.id}
                                confirmMessage={`${formatKrw(payment.amount)}을 전액 환불할까요? 환불하면 이 결제로 열린 후원자 전용 기능이 즉시 종료되고, 정기 후원 중이라면 자동 결제도 함께 취소됩니다.`}
                                label="환불 신청"
                              />
                            ) : (
                              <span className="text-xs whitespace-nowrap text-muted-foreground">
                                {refundBlockedLabel(state?.reason ?? "")}
                              </span>
                            )}
                          </TableCell>
                        </TableRow>
                        <TableRow className="hover:bg-transparent">
                          <TableCell
                            colSpan={4}
                            className="px-3 pt-0 pb-3 text-xs text-muted-foreground sm:px-4"
                          >
                            <div className="flex flex-wrap gap-x-4 gap-y-1">
                              {payment.period_start && payment.period_end ? (
                                <span>
                                  이용 기간 {formatDate(payment.period_start)} ~{" "}
                                  {formatDate(payment.period_end)}
                                </span>
                              ) : null}
                              {payment.refunded_amount > 0 ? (
                                <span>
                                  환불 {formatKrw(payment.refunded_amount)}
                                  {payment.refunded_at
                                    ? ` (${formatDate(payment.refunded_at)})`
                                    : ""}
                                </span>
                              ) : null}
                              {/* 전화로 불러 주는 번호라 중간에 끊기면 안
                                  된다. 스무 자로 고정이라 끊지 않아도 한 줄에
                                  들어간다. */}
                              <span className="whitespace-nowrap">
                                주문번호{" "}
                                <span className="font-mono tracking-wide">
                                  {payment.order_id}
                                </span>
                              </span>
                            </div>
                          </TableCell>
                        </TableRow>
                      </Fragment>
                    );
                  })}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>

        <p className="text-sm text-muted-foreground">
          결제일로부터 {REFUND_WINDOW_DAYS}일 이내에 후원자 전용 기능을 사용하지
          않으셨다면 위에서 바로 전액 환불하실 수 있습니다. 환불하면 그 결제로
          제공된 후원자 전용 기능은 즉시 종료되고, 정기 후원 중이라면 자동
          결제도 함께 취소됩니다. 나루의 장애처럼 그 밖의 사유로 환불이
          필요하시면{" "}
          <a
            href="mailto:hello@naru.pub"
            className="text-primary underline hover:text-primary/80"
          >
            hello@naru.pub
          </a>{" "}
          으로 알려주세요.
        </p>
      </div>
    </div>
  );
}
