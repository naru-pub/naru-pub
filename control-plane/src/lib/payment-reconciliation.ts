import { db } from "@/lib/database";
import { BillingInterval, getPaymentByOrderId, TossApiError } from "@/lib/toss";
import {
  applyOneTimePayment,
  applySuccessfulCharge,
} from "@/lib/subscriptions";

const UNCONFIRMED_EXPIRY_MS = 30 * 60 * 1000;

export type ReconciliationResult =
  | { state: "done" }
  | { state: "pending" }
  | { state: "failed"; status: string }
  | { state: "expired" };

export async function reconcilePayment(
  paymentId: number,
): Promise<ReconciliationResult> {
  const payment = await db
    .selectFrom("payments")
    .selectAll()
    .where("id", "=", paymentId)
    .executeTakeFirstOrThrow();

  if (payment.status === "done") return { state: "done" };
  if (payment.status !== "pending") {
    return { state: "failed", status: payment.status };
  }

  let tossPayment;
  try {
    tossPayment = await getPaymentByOrderId(payment.order_id);
  } catch (error) {
    if (error instanceof TossApiError && error.status === 404) {
      if (
        Date.now() - new Date(payment.created_at).getTime() >
        UNCONFIRMED_EXPIRY_MS
      ) {
        await db
          .updateTable("payments")
          .set({ status: "expired" })
          .where("id", "=", payment.id)
          .where("status", "=", "pending")
          .execute();
        return { state: "expired" };
      }
      return { state: "pending" };
    }
    throw error;
  }

  const status = tossPayment.status.toLowerCase();
  if (
    tossPayment.orderId !== payment.order_id ||
    tossPayment.totalAmount !== payment.amount
  ) {
    throw new Error(`Toss payment mismatch for order ${payment.order_id}`);
  }

  if (status !== "done") {
    const finalStatuses = new Set([
      "canceled",
      "partial_canceled",
      "aborted",
      "expired",
      "failed",
    ]);
    if (finalStatuses.has(status)) {
      await db
        .updateTable("payments")
        .set({
          toss_payment_key: tossPayment.paymentKey,
          status,
          raw: JSON.stringify(tossPayment),
        })
        .where("id", "=", payment.id)
        .where("status", "=", "pending")
        .execute();
      return { state: "failed", status };
    }
    return { state: "pending" };
  }

  if (payment.attempt_key?.startsWith("one_time:")) {
    await applyOneTimePayment({
      userId: payment.user_id,
      amount: payment.amount,
      interval: "year",
      payment: tossPayment,
      paymentId: payment.id,
    });
    return { state: "done" };
  }

  if (!payment.subscription_id) {
    throw new Error(`Payment ${payment.id} has no subscription`);
  }
  const subscription = await db
    .selectFrom("subscriptions")
    .select(["billing_interval", "current_period_end", "status"])
    .where("id", "=", payment.subscription_id)
    .where("user_id", "=", payment.user_id)
    .executeTakeFirstOrThrow();
  const now = new Date();
  const initial = payment.attempt_key?.startsWith("subscription_initial:");
  const currentEnd = subscription.current_period_end
    ? new Date(subscription.current_period_end)
    : now;
  const from = initial || currentEnd < now ? now : currentEnd;

  await applySuccessfulCharge({
    subscriptionId: payment.subscription_id,
    userId: payment.user_id,
    interval: subscription.billing_interval as BillingInterval,
    amount: payment.amount,
    from,
    preserveExistingEntitlement: initial,
    subscriptionStatus:
      subscription.status === "canceled" ? "canceled" : "active",
    payment: tossPayment,
    paymentId: payment.id,
  });
  return { state: "done" };
}
