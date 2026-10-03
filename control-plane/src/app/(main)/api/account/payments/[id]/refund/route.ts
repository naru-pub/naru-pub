import { NextRequest, NextResponse } from "next/server";
import { validateRequest } from "@/lib/auth";
import { db } from "@/lib/database";
import {
  requestRefund,
  refundProgress,
  RefundError,
} from "@/lib/payments/refunds";
import { PAYMENT_OPERATOR_USERS } from "@/lib/payments/support";
import { assertJsonContentType } from "@/lib/utils";
import { parseUuid } from "@/lib/uuid";

// 환불은 결제 내역에서 직접 신청합니다. 유료 이용자는 판매 정책의 조건(결제일로부터
// 7일 이내)을 만족할 때 스스로 환불할 수 있고, 결제 운영자는
// 그 밖의 사유 — 장애 보상이나 최종 취소 — 까지 포함해 어떤 결제든 환불할 수
// 있습니다.
async function handle(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
  accept: boolean,
) {
  try {
    try {
      if (accept) assertJsonContentType(request);
    } catch {
      return NextResponse.json(
        { success: false, message: "잘못된 요청입니다." },
        { status: 400 },
      );
    }

    const { user } = await validateRequest();
    if (!user) {
      return NextResponse.json(
        { success: false, message: "로그인이 필요합니다." },
        { status: 401 },
      );
    }

    const { id } = await context.params;
    const paymentId = parseUuid(id);
    if (!paymentId) {
      return NextResponse.json(
        { success: false, message: "잘못된 결제 번호입니다." },
        { status: 400 },
      );
    }

    const payment = await db
      .selectFrom("payments")
      .select(["id", "user_id"])
      .where("id", "=", paymentId)
      .executeTakeFirst();
    const isOperator = PAYMENT_OPERATOR_USERS.has(user.loginName);
    if (!payment || (payment.user_id !== user.id && !isOperator)) {
      return NextResponse.json(
        { success: false, message: "결제 내역을 찾을 수 없습니다." },
        { status: 404 },
      );
    }

    // An operator refunding their own payment is still an operator decision;
    // the policy check only binds a supporter refunding for themselves. A
    // refund always ends the account's recurring plan.
    const result = accept
      ? await requestRefund({
          paymentId,
          overridePolicy: isOperator,
          reason: isOperator ? "나루 운영자 환불" : "유료 이용자 환불 신청",
        })
      : await refundProgress(paymentId);

    return NextResponse.json(
      {
        success: true,
        result,
        message:
          result.state === "completed"
            ? "환불이 완료되었습니다."
            : result.state === "failed"
              ? "환불 처리를 확인해야 합니다. 운영자에게 문의해 주세요."
              : "환불 신청을 접수했습니다. 처리 결과는 결제 내역에서 확인할 수 있습니다.",
      },
      {
        status: accept && result.state === "pending" ? 202 : 200,
        headers: { "Cache-Control": "no-store" },
      },
    );
  } catch (error) {
    if (error instanceof RefundError) {
      return NextResponse.json(
        { success: false, message: error.message },
        { status: error.status },
      );
    }
    console.error("Payment refund error:", error);
    return NextResponse.json(
      { success: false, message: "환불 처리에 실패했습니다." },
      { status: 500 },
    );
  }
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  return handle(request, context, true);
}
export async function GET(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  return handle(request, context, false);
}
