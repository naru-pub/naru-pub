import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { validateRequest } from "@/lib/auth";
import { db } from "@/lib/database";
import {
  isOneTimeYears,
  newOrderId,
  oneTimeAmount,
  oneTimeOrderName,
} from "@/lib/toss";

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

    // Empty bodies from the previous web client continue to mean one year
    // during a blue-green rollout.
    const body = await request.json().catch(() => ({ years: 1 }));
    const years = body?.years;
    if (!isOneTimeYears(years)) {
      return NextResponse.json(
        { success: false, message: "후원 기간이 올바르지 않습니다." },
        { status: 400 },
      );
    }
    const amount = oneTimeAmount(years);

    // Ensure a stable customerKey for dashboard linkage (optional for one-time).
    const userRow = await db
      .selectFrom("users")
      .select("toss_customer_key")
      .where("id", "=", user.id)
      .executeTakeFirst();
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
