import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { validateRequest } from "@/lib/auth";
import { db } from "@/lib/database";
import { assertJsonContentType } from "@/lib/utils";
import {
  confirmPayment,
  describeTossError,
  isDefinitiveTossFailure,
  oneTimeYearsForAmount,
  TossApiError,
} from "@/lib/payments/toss";
import { confirmOrder } from "@/lib/payments/toss-gateway";
import { applyVerifiedTossPayment } from "@/lib/payments/payment-facts";
import { notePaymentEvent, won } from "@/lib/payments/payment-events";
import { oneTimeOrderSuperseded } from "@/lib/payments/payment-reconciliation";
import { AccountBusyError, withAccountLock } from "@/lib/payments/account-lock";

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

    // Under the account lock (lib/payments/account-lock): no renewal is charging the
    // plan this approval may switch off, and no second confirm of this
    // account runs meanwhile. The callback retries a 503 within the 10
    // minutes Toss allows; so does the reconciler.
    try {
      return await withAccountLock(user.id, { waitMs: 5000 }, async () => {
        const pendingPayment = await db
          .selectFrom("payments")
          .select(["id", "user_id", "amount", "status", "created_at"])
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

        // Another one-time payment already bought this period — a second tab, or
        // a retry after this one's confirm looked stuck — or a recurring plan
        // started meanwhile. Not approving it lets Toss expire the
        // authentication without charging the card.
        if (await oneTimeOrderSuperseded(pendingPayment)) {
          return NextResponse.json(
            {
              success: false,
              message:
                "다른 결제로 이미 이용 기간이 늘어났거나 정기 결제가 진행 중이라 이 결제는 승인하지 않았습니다. 카드에는 청구되지 않습니다.",
            },
            { status: 409 },
          );
        }

        // The amount is the one recorded at prepare, never the callback's.
        // A failed confirm is not a failed payment until the order says so,
        // and one still authenticated after an ambiguous failure is confirmed
        // once more under a fresh key (lib/payments/toss-gateway).
        const outcome = await confirmOrder({
          paymentKey,
          orderId,
          amount: pendingPayment.amount,
          firstKey: orderId,
          retryOnce: true,
          // Recorded before each call: an order Toss has not heard of expires
          // 45 minutes after its last attempt, never under a confirm in flight.
          beforeSend: async () => {
            await db
              .updateTable("payments")
              .set({ charge_attempted_at: new Date() })
              .where("id", "=", pendingPayment.id)
              .execute();
          },
        });
        if (outcome.kind !== "approved") {
          const declined = outcome.kind === "declined";
          if (outcome.kind !== "declined" || !outcome.payment)
            await notePaymentEvent({
              kind: declined ? "charge_failed" : "charge_unresolved",
              userId: user.id,
              paymentId: pendingPayment.id,
              summary: `한 번만 결제 ${won(pendingPayment.amount)} 승인 ${declined ? "실패" : "결과 불분명"}: ${
                outcome.kind === "unknown" && outcome.tossStatus
                  ? `Toss 상태 ${outcome.tossStatus}`
                  : describeTossError(outcome.error)
              }`,
            });
          if (outcome.kind === "declined") {
            const ended = outcome.payment;
            if (ended) {
              await applyVerifiedTossPayment(pendingPayment.id, ended);
            } else {
              await db
                .updateTable("payments")
                .set({
                  status: "failed",
                  raw: JSON.stringify({
                    error: describeTossError(outcome.error),
                  }),
                })
                .where("id", "=", pendingPayment.id)
                .where("status", "=", "pending")
                .execute();
            }
          }
          const message =
            outcome.kind === "declined" && outcome.error instanceof TossApiError
              ? outcome.error.message
              : "결제 결과를 확인하고 있습니다. 잠시 후 다시 시도해 주세요.";
          return NextResponse.json(
            { success: false, message },
            { status: declined ? 402 : 503 },
          );
        }
        const payment = outcome.payment;

        await applyVerifiedTossPayment(pendingPayment.id, payment);

        // The grant owes the thank-you (lib/payments/payment-jobs); a doubled callback,
        // or the reconciler settling this order first, finds it already owed.

        return NextResponse.json({
          success: true,
          message: `결제해 주셔서 감사합니다! ${years}년간 유료 기능을 이용하실 수 있습니다.`,
        });
      });
    } catch (error) {
      if (error instanceof AccountBusyError) {
        return NextResponse.json(
          {
            success: false,
            message: "결제를 처리하고 있습니다. 잠시 후 다시 확인해 주세요.",
          },
          { status: 503 },
        );
      }
      throw error;
    }
  } catch (error) {
    console.error("One-time confirm error:", error);
    return NextResponse.json(
      { success: false, message: "결제 처리 중 오류가 발생했습니다." },
      { status: 500 },
    );
  }
}
