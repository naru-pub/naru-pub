import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { validateRequest } from "@/lib/auth";
import { db } from "@/lib/database";
import { assertJsonContentType } from "@/lib/utils";
import { isBillingInterval, PLAN_AMOUNTS } from "@/lib/toss";
import { canStartRecurringPurchase } from "@/lib/support-purchases";

// Step 1 of the subscribe flow: records the chosen plan as an incomplete
// subscription and returns the stable Toss customerKey for requestBillingAuth.
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

    const { interval } = await request.json();
    if (!isBillingInterval(interval)) {
      return NextResponse.json(
        { success: false, message: "유효하지 않은 후원 주기입니다." },
        { status: 400 },
      );
    }

    const existing = await db
      .selectFrom("subscriptions")
      .select(["id", "status"])
      .where("user_id", "=", user.id)
      .executeTakeFirst();

    // Ensure a stable per-user customerKey.
    const userRow = await db
      .selectFrom("users")
      .select(["supporter_comp", "supporter_until", "toss_customer_key"])
      .where("id", "=", user.id)
      .executeTakeFirst();

    if (
      !canStartRecurringPurchase({
        supporterComp: !!userRow?.supporter_comp,
        supporterUntil: userRow?.supporter_until ?? null,
        subscriptionStatus: existing?.status ?? null,
      })
    ) {
      return NextResponse.json(
        {
          success: false,
          message: "이미 활성화되었거나 예약된 정기 후원이 있습니다.",
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

    const amount = PLAN_AMOUNTS[interval];

    if (existing) {
      await db
        .updateTable("subscriptions")
        .set({
          plan: "supporter",
          billing_interval: interval,
          amount,
          status: "incomplete",
          toss_customer_key: customerKey,
          toss_billing_key: null,
          updated_at: new Date(),
        })
        .where("id", "=", existing.id)
        .execute();
    } else {
      await db
        .insertInto("subscriptions")
        .values({
          user_id: user.id,
          plan: "supporter",
          billing_interval: interval,
          amount,
          status: "incomplete",
          toss_customer_key: customerKey,
        })
        .execute();
    }

    return NextResponse.json({ success: true, customerKey });
  } catch (error) {
    console.error("Subscription prepare error:", error);
    return NextResponse.json(
      { success: false, message: "후원 준비 중 오류가 발생했습니다." },
      { status: 500 },
    );
  }
}
