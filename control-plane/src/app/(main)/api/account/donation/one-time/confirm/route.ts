import { NextRequest, NextResponse } from "next/server";
import { validateRequest } from "@/lib/auth";
import { db } from "@/lib/database";
import { assertJsonContentType } from "@/lib/utils";
import { oneTimeYearsForAmount } from "@/lib/payments/toss";
import { enqueueOneTimeConfirmation } from "@/lib/payments/one-time-payments";
import { oneTimeOrderSuperseded } from "@/lib/payments/payment-reconciliation";
import { AccountBusyError, withAccountLock } from "@/lib/payments/account-lock";

// Accept the authenticated order. Only its Absurd task calls Toss to approve it.
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

    let body;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json(
        { success: false, message: "유효하지 않은 요청입니다." },
        { status: 400 },
      );
    }
    const { paymentKey, orderId, amount } = body ?? {};
    if (
      typeof paymentKey !== "string" ||
      !paymentKey.trim() ||
      paymentKey.length > 200 ||
      typeof orderId !== "string" ||
      !orderId ||
      orderId.length > 64 ||
      typeof amount !== "number"
    ) {
      return NextResponse.json(
        { success: false, message: "유효하지 않은 요청입니다." },
        { status: 400 },
      );
    }

    // Under the account lock (lib/payments/account-lock): no renewal is charging the
    // plan this approval may switch off, and acceptance cannot race another
    // purchase. The task checks eligibility again under the same lock.
    try {
      return await withAccountLock(user.id, { waitMs: 5000 }, async () => {
        const pendingPayment = await db
          .selectFrom("payments")
          .select([
            "id",
            "user_id",
            "amount",
            "status",
            "created_at",
            "toss_payment_key",
          ])
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

        if (
          pendingPayment.toss_payment_key &&
          pendingPayment.toss_payment_key !== paymentKey
        ) {
          return NextResponse.json(
            {
              success: false,
              message: "결제 승인 정보가 주문과 맞지 않습니다.",
            },
            { status: 409 },
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
        if (
          !pendingPayment.toss_payment_key &&
          (await oneTimeOrderSuperseded(pendingPayment))
        ) {
          return NextResponse.json(
            {
              success: false,
              message:
                "다른 결제로 이미 이용 기간이 늘어났거나 정기 결제가 진행 중이라 이 결제는 승인하지 않았습니다. 카드에는 청구되지 않습니다.",
            },
            { status: 409 },
          );
        }

        await enqueueOneTimeConfirmation(pendingPayment.id, paymentKey);
        return NextResponse.json(
          {
            success: true,
            chargeQueued: true,
            paymentId: pendingPayment.id,
            message: "결제를 접수했습니다. 결과는 결제 내역에서 확인해 주세요.",
          },
          { status: 202 },
        );
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
