import { NextRequest, NextResponse } from "next/server";
import { validateRequest } from "@/lib/auth";
import { db } from "@/lib/database";

// Cancels auto-renewal. Access (supporter_until) is left intact so the user
// keeps the feature through the already-paid period; the renewal cron skips
// non-active subscriptions.
export async function POST(_request: NextRequest) {
  try {
    const { user } = await validateRequest();
    if (!user) {
      return NextResponse.json(
        { success: false, message: "로그인이 필요합니다." },
        { status: 401 },
      );
    }

    const sub = await db
      .selectFrom("subscriptions")
      .select(["id", "status"])
      .where("user_id", "=", user.id)
      .executeTakeFirst();

    if (!sub) {
      return NextResponse.json(
        { success: false, message: "후원 정보가 없습니다." },
        { status: 404 },
      );
    }
    if (["canceled", "switched_to_one_time"].includes(sub.status)) {
      return NextResponse.json({
        success: true,
        message: "활성화된 정기 후원이 없습니다.",
      });
    }

    const cancelingSchedule = sub.status === "scheduled";
    await db
      .updateTable("subscriptions")
      .set({
        status: cancelingSchedule ? "switched_to_one_time" : "canceled",
        toss_billing_key: null,
        canceled_at: new Date(),
        next_billing_at: null,
        updated_at: new Date(),
      })
      .where("id", "=", sub.id)
      .execute();

    return NextResponse.json({
      success: true,
      message: cancelingSchedule
        ? "정기 후원 예약이 취소되었습니다."
        : "후원이 취소되었습니다. 남은 기간 동안은 계속 이용하실 수 있습니다.",
    });
  } catch (error) {
    console.error("Subscription cancel error:", error);
    return NextResponse.json(
      { success: false, message: "후원 취소 중 오류가 발생했습니다." },
      { status: 500 },
    );
  }
}
