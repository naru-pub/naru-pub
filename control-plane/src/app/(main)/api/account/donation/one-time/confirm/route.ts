import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { validateRequest } from "@/lib/auth";
import { db } from "@/lib/database";
import { assertJsonContentType } from "@/lib/utils";
import { sendSupportThankYouEmail } from "@/lib/email";
import {
  confirmPayment,
  describeTossError,
  isDefinitiveTossFailure,
  oneTimeYearsForAmount,
  paymentProviderMetadata,
  TossApiError,
} from "@/lib/toss";
import { settleFailedOrder } from "@/lib/toss-orders";
import { applyOneTimePayment } from "@/lib/subscriptions";
import { notePaymentEvent, won } from "@/lib/payment-events";

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
        { success: false, message: "결제 주문을 찾을 수 없습니다." },
        { status: 404 },
      );
    }

    if (pendingPayment.status === "done") {
      return NextResponse.json({
        success: true,
        message: "이미 처리된 결제입니다.",
      });
    }

    const years = oneTimeYearsForAmount(pendingPayment.amount);
    if (
      pendingPayment.status !== "pending" ||
      years === null ||
      amount !== pendingPayment.amount
    ) {
      return NextResponse.json(
        { success: false, message: "결제 주문 정보가 올바르지 않습니다." },
        { status: 400 },
      );
    }

    const params = { paymentKey, orderId, amount: pendingPayment.amount };
    let payment;
    try {
      payment = await confirmPayment(params, orderId);
    } catch (err) {
      let error = err;
      // A failed confirm is not yet a failed payment: look the order up first.
      let settled = await settleFailedOrder({
        orderId,
        amount: pendingPayment.amount,
        flow: "one-time",
        error,
      });
      // Still authenticated but not approved after an ambiguous failure:
      // confirm once more under a new idempotency key. The old key would
      // only replay the first answer, while the 10 minutes Toss allows for
      // confirming run out. A second approval of the same payment is
      // refused by Toss (ALREADY_PROCESSED_PAYMENT), so a new key cannot
      // charge twice. A 409 means the first confirm is still running.
      if (
        settled.state === "unknown" &&
        settled.tossStatus === "IN_PROGRESS" &&
        !isDefinitiveTossFailure(error) &&
        !(error instanceof TossApiError && error.status === 409)
      ) {
        try {
          payment = await confirmPayment(params, `${orderId}:${randomUUID()}`);
        } catch (retryError) {
          error = retryError;
          settled = await settleFailedOrder({
            orderId,
            amount: pendingPayment.amount,
            flow: "one-time",
            error,
          });
        }
      }
      if (!payment && settled.state === "paid") payment = settled.payment;

      if (!payment) {
        const refused = settled.state === "refused";
        await notePaymentEvent({
          kind: refused ? "charge_failed" : "charge_unresolved",
          userId: user.id,
          paymentId: pendingPayment.id,
          summary: `한 번만 결제 ${won(pendingPayment.amount)} 승인 ${refused ? "실패" : "결과 불분명"}: ${describeTossError(error)}`,
        });
        if (settled.state === "refused") {
          const declined = settled.payment;
          await db
            .updateTable("payments")
            .set({
              ...(declined
                ? {
                    ...paymentProviderMetadata(declined, "one-time"),
                    toss_payment_key: declined.paymentKey,
                  }
                : {}),
              status: "failed",
              raw: JSON.stringify(
                declined ?? { error: describeTossError(error) },
              ),
            })
            .where("id", "=", pendingPayment.id)
            .where("status", "=", "pending")
            .execute();
        }
        const message =
          refused && error instanceof TossApiError
            ? error.message
            : "결제 결과를 확인하고 있습니다. 잠시 후 다시 시도해 주세요.";
        return NextResponse.json(
          { success: false, message },
          { status: refused ? 402 : 503 },
        );
      }
    }

    // Grant based on the amount Toss actually confirmed.
    if (
      payment.status !== "DONE" ||
      payment.totalAmount !== pendingPayment.amount
    ) {
      await db
        .updateTable("payments")
        .set({
          ...paymentProviderMetadata(payment, "one-time"),
          toss_payment_key: payment.paymentKey,
          order_id: payment.orderId ?? orderId,
          amount: payment.totalAmount ?? amount,
          status: "failed",
          raw: JSON.stringify(payment),
        })
        .where("id", "=", pendingPayment.id)
        .where("status", "=", "pending")
        .execute();
      await notePaymentEvent({
        kind: "charge_failed",
        userId: user.id,
        paymentId: pendingPayment.id,
        summary: `한 번만 결제 ${won(pendingPayment.amount)}: Toss 상태 ${payment.status}, 금액 ${payment.totalAmount}`,
      });
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

    // A doubled callback, or the reconciler settling this order first, finds
    // the period already granted, and its thank-you already sent.
    if (period.granted && user.email && user.emailVerifiedAt) {
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
      message: `결제해 주셔서 감사합니다! ${years}년간 유료 기능을 이용하실 수 있습니다.`,
    });
  } catch (error) {
    console.error("One-time confirm error:", error);
    return NextResponse.json(
      { success: false, message: "결제 처리 중 오류가 발생했습니다." },
      { status: 500 },
    );
  }
}
