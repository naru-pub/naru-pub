import { NextRequest, NextResponse } from "next/server";
import { validateRequest } from "@/lib/auth";
import { db } from "@/lib/database";
import { assertJsonContentType } from "@/lib/utils";
import { sendSupportThankYouEmail } from "@/lib/email";
import {
  BillingInterval,
  chargeBillingKey,
  getPaymentByOrderId,
  issueBillingKey,
  isDefinitiveTossFailure,
  newOrderId,
  PLAN_ORDER_NAMES,
  TossApiError,
} from "@/lib/toss";
import { applySuccessfulCharge } from "@/lib/subscriptions";
import { scheduledRecurringStart } from "@/lib/support-purchases";

async function getOrCreateInitialChargeAttempt(opts: {
  subscriptionId: number;
  userId: number;
  amount: number;
}) {
  const prefix = `subscription_initial:${opts.subscriptionId}:`;

  const pending = await db
    .selectFrom("payments")
    .select(["id", "order_id", "status"])
    .where("subscription_id", "=", opts.subscriptionId)
    .where("attempt_key", "like", `${prefix}%`)
    .where("status", "=", "pending")
    .orderBy("id", "desc")
    .executeTakeFirst();

  if (pending) return pending;

  const countRow = await db
    .selectFrom("payments")
    .select(({ fn }) => fn.countAll().as("count"))
    .where("subscription_id", "=", opts.subscriptionId)
    .where("attempt_key", "like", `${prefix}%`)
    .executeTakeFirst();
  const attemptNumber = Number(countRow?.count ?? 0) + 1;

  try {
    return await db
      .insertInto("payments")
      .values({
        attempt_key: `${prefix}${attemptNumber}`,
        user_id: opts.userId,
        subscription_id: opts.subscriptionId,
        order_id: newOrderId(),
        amount: opts.amount,
        status: "pending",
      })
      .returning(["id", "order_id", "status"])
      .executeTakeFirstOrThrow();
  } catch (error) {
    const concurrent = await db
      .selectFrom("payments")
      .select(["id", "order_id", "status"])
      .where("subscription_id", "=", opts.subscriptionId)
      .where("attempt_key", "like", `${prefix}%`)
      .where("status", "=", "pending")
      .orderBy("id", "desc")
      .executeTakeFirst();
    if (concurrent) return concurrent;
    throw error;
  }
}

// Step 2 of the subscribe flow: exchanges the authKey for a billing key. When
// prepaid access remains, the first charge is scheduled for its expiry;
// otherwise the first period is charged immediately.
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

    const { authKey, customerKey } = await request.json();
    if (typeof authKey !== "string" || typeof customerKey !== "string") {
      return NextResponse.json(
        { success: false, message: "유효하지 않은 요청입니다." },
        { status: 400 },
      );
    }

    // The customerKey must belong to this user.
    const userRow = await db
      .selectFrom("users")
      .select([
        "email",
        "email_verified_at",
        "login_name",
        "supporter_until",
        "toss_customer_key",
      ])
      .where("id", "=", user.id)
      .executeTakeFirst();
    if (
      !userRow?.toss_customer_key ||
      userRow.toss_customer_key !== customerKey
    ) {
      return NextResponse.json(
        { success: false, message: "유효하지 않은 요청입니다." },
        { status: 403 },
      );
    }

    const sub = await db
      .selectFrom("subscriptions")
      .select([
        "id",
        "billing_interval",
        "amount",
        "status",
        "toss_billing_key",
      ])
      .where("user_id", "=", user.id)
      .executeTakeFirst();
    if (!sub) {
      return NextResponse.json(
        { success: false, message: "후원 정보를 찾을 수 없습니다." },
        { status: 400 },
      );
    }
    if (sub.status === "active") {
      return NextResponse.json({
        success: true,
        message: "이미 후원 중입니다.",
      });
    }

    const interval = sub.billing_interval as BillingInterval;

    // Issue a reusable billing key from the one-time authKey.
    let billingKey = sub.toss_billing_key;
    if (!billingKey) {
      const issued = await issueBillingKey(authKey, customerKey);
      billingKey = issued.billingKey;
      await db
        .updateTable("subscriptions")
        .set({ toss_billing_key: billingKey, updated_at: new Date() })
        .where("id", "=", sub.id)
        .execute();
    }

    const now = new Date();
    const scheduledStart = scheduledRecurringStart(
      userRow.supporter_until ?? null,
      now,
    );
    if (scheduledStart) {
      await db
        .updateTable("subscriptions")
        .set({
          status: "scheduled",
          current_period_start: null,
          current_period_end: scheduledStart,
          next_billing_at: scheduledStart,
          failed_charge_count: 0,
          charging_started_at: null,
          canceled_at: null,
          updated_at: now,
        })
        .where("id", "=", sub.id)
        .execute();

      return NextResponse.json({
        success: true,
        scheduled: true,
        startsAt: scheduledStart.toISOString(),
        message: "현재 후원 기간이 끝난 뒤 정기 후원이 시작됩니다.",
      });
    }

    // Charge the first period.
    const attempt = await getOrCreateInitialChargeAttempt({
      subscriptionId: sub.id,
      userId: user.id,
      amount: sub.amount,
    });
    let payment;
    try {
      try {
        const existingPayment = await getPaymentByOrderId(attempt.order_id);
        if (existingPayment.status === "DONE") {
          payment = existingPayment;
        }
      } catch (err) {
        if (!(err instanceof TossApiError && err.status === 404)) {
          throw err;
        }
      }

      payment ??= await chargeBillingKey({
        billingKey,
        customerKey,
        amount: sub.amount,
        orderId: attempt.order_id,
        orderName: PLAN_ORDER_NAMES[interval],
        idempotencyKey: attempt.order_id,
      });
    } catch (err) {
      // A transport error is ambiguous: Toss may have completed the charge.
      // Keep the attempt pending so the next callback reconciles this orderId.
      if (isDefinitiveTossFailure(err)) {
        await db
          .updateTable("payments")
          .set({
            status: "failed",
            raw: JSON.stringify({ error: err.message }),
          })
          .where("id", "=", attempt.id)
          .execute();
      }
      const message =
        err instanceof TossApiError
          ? err.message
          : "결제 결과를 확인하고 있습니다. 잠시 후 다시 시도해 주세요.";
      return NextResponse.json(
        { success: false, message },
        { status: isDefinitiveTossFailure(err) ? 402 : 503 },
      );
    }

    if (payment.status !== "DONE") {
      await db
        .updateTable("payments")
        .set({
          toss_payment_key: payment.paymentKey,
          order_id: payment.orderId ?? attempt.order_id,
          amount: sub.amount,
          status: "failed",
          raw: JSON.stringify(payment),
        })
        .where("id", "=", attempt.id)
        .execute();
      return NextResponse.json(
        { success: false, message: "결제가 완료되지 않았습니다." },
        { status: 402 },
      );
    }

    const period = await applySuccessfulCharge({
      subscriptionId: sub.id,
      userId: user.id,
      interval,
      amount: sub.amount,
      from: now,
      preserveExistingEntitlement: true,
      payment,
      paymentId: attempt.id,
    });

    if (userRow.email && userRow.email_verified_at) {
      try {
        await sendSupportThankYouEmail({
          email: userRow.email,
          loginName: userRow.login_name,
          kind: "recurring",
          amount: sub.amount,
          supporterUntil: period.periodEnd,
        });
      } catch (error) {
        console.error("Support thank-you email error:", error);
      }
    }

    return NextResponse.json({
      success: true,
      message: "후원이 시작되었습니다. 감사합니다!",
    });
  } catch (error) {
    console.error("Subscription confirm error:", error);
    return NextResponse.json(
      { success: false, message: "후원 처리 중 오류가 발생했습니다." },
      { status: 500 },
    );
  }
}
