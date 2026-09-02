import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { validateRequest } from "@/lib/auth";
import {
  EMAIL_VERIFICATION_REQUIRED_MESSAGE,
  hasVerifiedEmail,
} from "@/lib/support";
import { db } from "@/lib/database";
import {
  isPurchasableOneTimeYears,
  newOrderId,
  oneTimeAmount,
  oneTimeOrderName,
} from "@/lib/toss";
import { canStartOneTimePurchase } from "@/lib/support-purchases";

// One-time donation step 1: returns a server-generated orderId + the
// authoritative amount for requestPayment.
export async function POST(request: NextRequest) {
  try {
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
        { success: false, message: "후원 기간이 올바르지 않습니다." },
        { status: 400 },
      );
    }
    const amount = oneTimeAmount(years);

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
          message:
            "일회성 후원 기간 중에는 정기 후원으로만 전환할 수 있습니다.",
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

    const orderId = newOrderId();

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
      { success: false, message: "후원 준비 중 오류가 발생했습니다." },
      { status: 500 },
    );
  }
}
