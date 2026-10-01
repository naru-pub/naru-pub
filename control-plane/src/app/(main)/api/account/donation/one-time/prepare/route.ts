import { NextRequest, NextResponse } from "next/server";
import { assertSameOriginRequest } from "@/lib/utils";
import { randomUUID } from "crypto";
import { validateRequest } from "@/lib/auth";
import {
  EMAIL_VERIFICATION_REQUIRED_MESSAGE,
  hasVerifiedEmail,
} from "@/lib/support";
import { db } from "@/lib/database";
import {
  isPurchasableOneTimeYears,
  withNewOrderId,
  oneTimeAmount,
  oneTimeOrderName,
} from "@/lib/toss";
import { canStartOneTimePurchase } from "@/lib/support-purchases";
import { reconcilePayment } from "@/lib/payment-reconciliation";
import { settlePendingCharges } from "@/lib/subscription-signup";

// One-time donation step 1: returns a server-generated orderId + the
// authoritative amount for requestPayment.
export async function POST(request: NextRequest) {
  try {
    try {
      assertSameOriginRequest(request);
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

    if (!hasVerifiedEmail(user)) {
      return NextResponse.json(
        { success: false, message: EMAIL_VERIFICATION_REQUIRED_MESSAGE },
        { status: 403 },
      );
    }

    // Empty bodies from the previous web client continue to mean one year
    // during a blue-green rollout.
    const body = await request.json().catch(() => ({ years: 1 }));
    const years = body?.years;
    if (!isPurchasableOneTimeYears(years)) {
      return NextResponse.json(
        { success: false, message: "결제 기간이 올바르지 않습니다." },
        { status: 400 },
      );
    }
    const amount = oneTimeAmount(years);

    // Settle what may still turn into paid time before deciding whether a
    // one-time purchase is allowed: an earlier one-time order the buyer
    // authenticated (the reconciler confirms it) or that Toss already
    // approved, and a subscription's unresolved charges. An order Toss never
    // saw — a closed payment window — stays pending and does not block.
    const pendingOneTime = await db
      .selectFrom("payments")
      .select("id")
      .where("user_id", "=", user.id)
      .where("attempt_key", "like", "one_time:%")
      .where("status", "=", "pending")
      .execute();
    for (const payment of pendingOneTime) {
      await reconcilePayment(payment.id).catch((error) =>
        console.error(
          `One-time prepare: reconciling payment ${payment.id} failed`,
          error,
        ),
      );
    }
    const existingSubscription = await db
      .selectFrom("subscriptions")
      .select("id")
      .where("user_id", "=", user.id)
      .executeTakeFirst();
    // A subscription charge that may yet succeed would land beside this
    // purchase — the same check a new signup makes.
    if (
      existingSubscription &&
      !(await settlePendingCharges(existingSubscription.id))
    ) {
      return NextResponse.json(
        {
          success: false,
          message:
            "이전 결제 결과를 확인하고 있습니다. 잠시 후 다시 시도해 주세요.",
        },
        { status: 409 },
      );
    }

    // Ensure a stable customerKey for dashboard linkage (optional for one-time).
    const userRow = await db
      .selectFrom("users")
      .select(["supporter_comp", "supporter_until", "toss_customer_key"])
      .where("id", "=", user.id)
      .executeTakeFirst();
    const subscription = await db
      .selectFrom("subscriptions")
      .select("status")
      .where("user_id", "=", user.id)
      .executeTakeFirst();
    if (
      !canStartOneTimePurchase({
        supporterComp: !!userRow?.supporter_comp,
        supporterUntil: userRow?.supporter_until ?? null,
        subscriptionStatus: subscription?.status ?? null,
      })
    ) {
      return NextResponse.json(
        {
          success: false,
          message: "일회성 결제 기간 중에는 정기 결제로만 전환할 수 있습니다.",
        },
        { status: 409 },
      );
    }
    let customerKey = userRow?.toss_customer_key ?? null;
    if (!customerKey) {
      customerKey = randomUUID();
      await db
        .updateTable("users")
        .set({ toss_customer_key: customerKey })
        .where("id", "=", user.id)
        .execute();
    }

    const orderId = await withNewOrderId(async (orderId) => {
      await db
        .insertInto("payments")
        .values({
          attempt_key: `one_time:${years}:${orderId}`,
          user_id: user.id,
          subscription_id: null,
          order_id: orderId,
          amount,
          status: "pending",
        })
        .execute();
      return orderId;
    });

    return NextResponse.json({
      success: true,
      customerKey,
      orderId,
      amount,
      orderName: oneTimeOrderName(years),
    });
  } catch (error) {
    console.error("One-time prepare error:", error);
    return NextResponse.json(
      { success: false, message: "결제 준비 중 오류가 발생했습니다." },
      { status: 500 },
    );
  }
}
