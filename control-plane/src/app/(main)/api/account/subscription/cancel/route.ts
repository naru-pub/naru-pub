import { NextRequest, NextResponse } from "next/server";
import { assertJsonContentType } from "@/lib/utils";
import { validateRequest } from "@/lib/auth";
import { db } from "@/lib/database";
import { deleteRetiredBillingKey } from "@/lib/payments/billing-keys";
import { runJobs } from "@/lib/payments/payment-jobs";
import { endPlan, plansOf } from "@/lib/payments/subscriptions";
import { AccountBusyError, withAccountLock } from "@/lib/payments/account-lock";

// Cancels auto-renewal. Access (supporter_until) is left intact so the user
// keeps the feature through the already-paid period; the renewal cron skips
// non-active subscriptions.
export async function POST(request: NextRequest) {
  try {
    try {
      // JSON only: a form a page on a user's subdomain posts (same site,
      // so the session cookie goes along) cannot set this type, and older
      // browsers send no Sec-Fetch-Site to refuse it by.
      assertJsonContentType(request);
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

    // Under the account lock (lib/payments/account-lock), so no renewal is charging
    // the plan meanwhile, and the plan is looked up only once it is held: a
    // signup confirming meanwhile may be starting the very plan this click
    // means to cancel, and a scheduled plan that was just charged is active
    // now — ending it is a cancel, not the withdrawal of a schedule that
    // never charged.
    let result;
    try {
      result = await withAccountLock(user.id, { waitMs: 10_000 }, () =>
        db.transaction().execute(async (trx) => {
          const current = await plansOf(trx, user.id)
            .select("id")
            .executeTakeFirst();
          if (!current) return { found: false as const };
          // Null when already ended: a second click, or a refund that
          // stopped the plan meanwhile, already did this and mailed about it.
          const stopped = await endPlan(trx, current.id, {
            summary: (from) =>
              from === "scheduled"
                ? "사용자가 예약된 정기 결제를 취소"
                : `사용자가 정기 결제를 취소 (${from}에서), 결제한 기간은 유지`,
            notice: (from) => (from === "scheduled" ? "user_schedule" : "user"),
          });
          return { found: true as const, stopped };
        }),
      );
    } catch (error) {
      if (error instanceof AccountBusyError) {
        return NextResponse.json(
          {
            success: false,
            message: "결제를 처리하고 있습니다. 잠시 후 다시 시도해 주세요.",
          },
          { status: 409 },
        );
      }
      throw error;
    }
    if (!result.found) {
      return NextResponse.json(
        { success: false, message: "결제 정보가 없습니다." },
        { status: 404 },
      );
    }
    const stopped = result.stopped;
    if (!stopped) {
      return NextResponse.json({
        success: true,
        message: "활성화된 정기 결제가 없습니다.",
      });
    }
    const cancelingSchedule = stopped.from === "scheduled";
    const wasPastDue = stopped.from === "past_due";
    await deleteRetiredBillingKey(stopped.retiredKey);
    await runJobs([stopped.noticeJob]);

    return NextResponse.json({
      success: true,
      // "해지", not "결제 취소": that is what a refund is called, on card
      // statements and in 나루's own refund mail.
      message: cancelingSchedule
        ? "정기 결제 예약을 취소했습니다. 결제된 금액은 없습니다."
        : wasPastDue
          ? "정기 결제를 해지하고 등록된 카드를 지웠습니다."
          : "정기 결제를 해지했습니다. 결제한 기간이 끝날 때까지는 계속 이용하실 수 있습니다.",
    });
  } catch (error) {
    console.error("Subscription cancel error:", error);
    return NextResponse.json(
      { success: false, message: "결제 취소 중 오류가 발생했습니다." },
      { status: 500 },
    );
  }
}
