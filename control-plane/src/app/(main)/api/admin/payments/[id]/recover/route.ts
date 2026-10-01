import { NextRequest, NextResponse } from "next/server";
import { validateRequest } from "@/lib/auth";
import {
  RecoveryError,
  recoverOrphanedCharge,
} from "@/lib/payments/payment-reconciliation";
import { PAYMENT_OPERATOR_USERS } from "@/lib/payments/support";
import { assertJsonContentType } from "@/lib/utils";
import { parseUuid } from "@/lib/uuid";

// Recovers a charge Toss approved for an order the ledger had already settled
// (charge_orphaned). Payment operators only.
export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  try {
    assertJsonContentType(request);
  } catch {
    return NextResponse.json(
      { success: false, message: "잘못된 요청입니다." },
      { status: 400 },
    );
  }

  const { user } = await validateRequest();
  if (!user || !PAYMENT_OPERATOR_USERS.has(user.loginName)) {
    return NextResponse.json(
      { success: false, message: "찾을 수 없습니다." },
      { status: 404 },
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

  try {
    const result = await recoverOrphanedCharge(paymentId);
    return NextResponse.json({
      success: true,
      result,
      message:
        result.state === "recovered"
          ? "Toss에서 승인된 결제라 기간을 부여했습니다."
          : `Toss에서 완료된 결제가 아닙니다 (${result.tossStatus ?? "주문 없음"}). 그대로 둡니다.`,
    });
  } catch (error) {
    if (error instanceof RecoveryError) {
      return NextResponse.json(
        { success: false, message: error.message },
        { status: 409 },
      );
    }
    console.error("Payment recovery error:", error);
    return NextResponse.json(
      { success: false, message: "결제를 복구하지 못했습니다." },
      { status: 503 },
    );
  }
}
