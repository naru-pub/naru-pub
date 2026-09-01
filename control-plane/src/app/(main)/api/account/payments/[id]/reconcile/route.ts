import { NextRequest, NextResponse } from "next/server";
import { validateRequest } from "@/lib/auth";
import { db } from "@/lib/database";
import { reconcilePayment } from "@/lib/payment-reconciliation";
import { assertJsonContentType } from "@/lib/utils";
import { PAYMENT_OPERATOR_USERS } from "@/lib/support";

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  try {
    assertJsonContentType(request);
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
    if (
      !payment ||
      (payment.user_id !== user.id &&
        !PAYMENT_OPERATOR_USERS.has(user.loginName))
    ) {
      return NextResponse.json(
        { success: false, message: "결제 내역을 찾을 수 없습니다." },
        { status: 404 },
      );
    }

    const result = await reconcilePayment(paymentId);
    return NextResponse.json({ success: true, result });
  } catch (error) {
    console.error("Payment reconciliation error:", error);
    return NextResponse.json(
      { success: false, message: "결제 상태 확인에 실패했습니다." },
      { status: 503 },
    );
  }
}
