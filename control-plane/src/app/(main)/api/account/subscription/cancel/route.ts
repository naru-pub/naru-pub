import { NextRequest, NextResponse } from "next/server";
import { assertJsonContentType } from "@/lib/utils";
import { validateRequest } from "@/lib/auth";
import { db } from "@/lib/database";
import { deleteRetiredBillingKey, retireBillingKey } from "@/lib/billing-keys";
import { sendSubscriptionCanceledNotice } from "@/lib/cancellation-notices";
import { recordPaymentEvent } from "@/lib/payment-events";
import { AccountBusyError, withAccountLock } from "@/lib/account-lock";

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

    const sub = await db
      .selectFrom("subscriptions")
      .select(["id", "status"])
      .where("user_id", "=", user.id)
      .executeTakeFirst();

    if (!sub) {
      return NextResponse.json(
        { success: false, message: "결제 정보가 없습니다." },
        { status: 404 },
      );
    }
    if (["canceled", "switched_to_one_time"].includes(sub.status)) {
      return NextResponse.json({
        success: true,
        message: "활성화된 정기 결제가 없습니다.",
      });
    }

    // Under the account lock (lib/account-lock), so no renewal is charging
    // the plan meanwhile; the status is read again under the row lock: a
    // scheduled plan that was just charged is active now, and ending it is a
    // cancel, not the withdrawal of a schedule that never charged.
    let result;
    try {
      result = await withAccountLock(user.id, { waitMs: 10_000 }, () =>
        db.transaction().execute(async (trx) => {
          const current = await trx
            .selectFrom("subscriptions")
            .select("status")
            .where("id", "=", sub.id)
            .forUpdate()
            .executeTakeFirstOrThrow();
          // Not again: a second click, or a refund that stopped the plan
          // meanwhile, already did this and mailed about it.
          if (["canceled", "switched_to_one_time"].includes(current.status)) {
            return undefined;
          }
          const cancelingSchedule = current.status === "scheduled";
          await trx
            .updateTable("subscriptions")
            .set({
              status: "canceled",
              canceled_at: new Date(),
              next_billing_at: null,
              updated_at: new Date(),
            })
            .where("id", "=", sub.id)
            .execute();
          await recordPaymentEvent(trx, {
            kind: "subscription_canceled",
            userId: user.id,
            subscriptionId: sub.id,
            summary: cancelingSchedule
              ? "사용자가 예약된 정기 결제를 취소"
              : `사용자가 정기 결제를 취소 (${current.status}에서), 결제한 기간은 유지`,
          });
          return {
            cancelingSchedule,
            wasPastDue: current.status === "past_due",
            billingKey: await retireBillingKey(trx, { subscriptionId: sub.id }),
          };
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
    const wasPastDue = result?.wasPastDue ?? false;
    const cancelingSchedule = result?.cancelingSchedule ?? false;
    const billingKey = result === undefined ? undefined : result.billingKey;
    if (billingKey !== undefined) {
      await deleteRetiredBillingKey(billingKey);
      await sendSubscriptionCanceledNotice(
        sub.id,
        cancelingSchedule ? "user_schedule" : "user",
      );
    }

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
