import { NextRequest, NextResponse } from "next/server";
import { validateRequest } from "@/lib/auth";
import { db } from "@/lib/database";
import { refundPayment, RefundError } from "@/lib/refunds";
import { PAYMENT_OPERATOR_USERS } from "@/lib/support";
import { TossApiError } from "@/lib/toss";
import { assertJsonContentType } from "@/lib/utils";

// 환불은 결제 내역에서 직접 신청합니다. 후원자는 판매 정책의 조건(7일 이내,
// 후원자 전용 기능 미사용)을 만족할 때 스스로 환불할 수 있고, 결제 운영자는
// 그 밖의 사유 — 장애 보상이나 최종 취소 — 까지 포함해 어떤 결제든 환불할 수
// 있습니다.
export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  try {
    try {
      assertJsonContentType(request);
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
    const paymentId = Number(id);
    if (!Number.isSafeInteger(paymentId) || paymentId <= 0) {
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
    // the policy check only binds a supporter refunding for themselves.
    const result = await refundPayment({
      paymentId,
      overridePolicy: isOperator,
      reason: isOperator ? "나루 운영자 환불" : "후원자 환불 신청",
    });

    return NextResponse.json({
      success: true,
      result,
      message: result.subscriptionCanceled
        ? "환불이 접수되었습니다. 정기 후원도 함께 취소되어 더 이상 결제되지 않습니다."
        : "환불이 접수되었습니다.",
    });
  } catch (error) {
    if (error instanceof RefundError) {
      return NextResponse.json(
        { success: false, message: error.message },
        { status: error.status },
      );
    }
    console.error("Payment refund error:", error);
    if (error instanceof TossApiError) {
      return NextResponse.json(
        {
          success: false,
          message:
            "결제사에서 환불을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.",
        },
        { status: 502 },
      );
    }
    return NextResponse.json(
      { success: false, message: "환불 처리에 실패했습니다." },
      { status: 500 },
    );
  }
}
