import { NextRequest, NextResponse } from "next/server";
import { validateRequest } from "@/lib/auth";
import { db } from "@/lib/database";
import { assertJsonContentType } from "@/lib/utils";
import { sendSupportThankYouEmail } from "@/lib/email";
import {
  confirmPayment,
  isDefinitiveTossFailure,
  oneTimeYearsForAmount,
  TossApiError,
} from "@/lib/toss";
import { applyOneTimePayment } from "@/lib/subscriptions";

// One-time donation step 2: confirms the payment with Toss and grants the
// purchased years of supporter access. Entitlement is derived from the
// server-recorded order amount and verified against what Toss reports.
export async function POST(request: NextRequest) {
  try {
    try {
      assertJsonContentType(request);
    } catch {
      return NextResponse.json(
        { success: false, message: "Invalid content type" },
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

    const { paymentKey, orderId, amount } = await request.json();
    if (
      typeof paymentKey !== "string" ||
      typeof orderId !== "string" ||
      typeof amount !== "number"
    ) {
      return NextResponse.json(
        { success: false, message: "유효하지 않은 요청입니다." },
        { status: 400 },
      );
    }

    const pendingPayment = await db
      .selectFrom("payments")
      .select(["id", "amount", "status"])
      .where("order_id", "=", orderId)
      .where("user_id", "=", user.id)
      .where("subscription_id", "is", null)
      .executeTakeFirst();

    if (!pendingPayment) {
      return NextResponse.json(
        { success: false, message: "후원 주문을 찾을 수 없습니다." },
        { status: 404 },
      );
    }

    if (pendingPayment.status === "done") {
      return NextResponse.json({
        success: true,
        message: "이미 처리된 후원입니다.",
      });
    }

    const years = oneTimeYearsForAmount(pendingPayment.amount);
    if (
      pendingPayment.status !== "pending" ||
      years === null ||
      amount !== pendingPayment.amount
    ) {
      return NextResponse.json(
        { success: false, message: "후원 주문 정보가 올바르지 않습니다." },
        { status: 400 },
      );
    }

    let payment;
    try {
      payment = await confirmPayment({ paymentKey, orderId, amount }, orderId);
    } catch (err) {
      // A transport failure may follow a successful approval. Keep the order
      // pending and retry safely with the same idempotency key.
      if (isDefinitiveTossFailure(err)) {
        await db
          .updateTable("payments")
          .set({
            status: "failed",
            raw: JSON.stringify({ error: err.message }),
          })
          .where("id", "=", pendingPayment.id)
          .execute();
      }
      const message =
        err instanceof TossApiError
          ? err.message
          : "결제 결과를 확인하고 있습니다. 잠시 후 다시 시도해 주세요.";
      return NextResponse.json(
        { success: false, message },
        { status: isDefinitiveTossFailure(err) ? 402 : 503 },
      );
    }

    // Grant based on the amount Toss actually confirmed.
    if (
      payment.status !== "DONE" ||
      payment.totalAmount !== pendingPayment.amount
    ) {
      await db
        .updateTable("payments")
        .set({
          toss_payment_key: payment.paymentKey,
          order_id: payment.orderId ?? orderId,
          amount: payment.totalAmount ?? amount,
          status: "failed",
          raw: JSON.stringify(payment),
        })
        .where("id", "=", pendingPayment.id)
        .execute();
      return NextResponse.json(
        { success: false, message: "결제가 올바르게 완료되지 않았습니다." },
        { status: 402 },
      );
    }

    const period = await applyOneTimePayment({
      userId: user.id,
      amount: pendingPayment.amount,
      years,
      payment,
      paymentId: pendingPayment.id,
    });

    if (user.email && user.emailVerifiedAt) {
      try {
        await sendSupportThankYouEmail({
          email: user.email,
          loginName: user.loginName,
          kind: "one_time",
          amount: pendingPayment.amount,
          supporterUntil: period.periodEnd,
        });
      } catch (error) {
        console.error("Support thank-you email error:", error);
      }
    }

    return NextResponse.json({
      success: true,
      message: `후원해 주셔서 감사합니다! ${years}년간 후원자 기능을 이용하실 수 있습니다.`,
    });
  } catch (error) {
    console.error("One-time confirm error:", error);
    return NextResponse.json(
      { success: false, message: "후원 처리 중 오류가 발생했습니다." },
      { status: 500 },
    );
  }
}
