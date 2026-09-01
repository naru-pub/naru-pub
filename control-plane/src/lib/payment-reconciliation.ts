import { db } from "@/lib/database";
import {
  BillingInterval,
  getPaymentByOrderId,
  TossApiError,
  TossPaymentResult,
} from "@/lib/toss";
import {
  applyOneTimePayment,
  applySuccessfulCharge,
} from "@/lib/subscriptions";

const UNCONFIRMED_EXPIRY_MS = 30 * 60 * 1000;

export function refundDetails(payment: TossPaymentResult, amount: number) {
  const cancels = payment.cancels ?? [];
  const refundedAmount = cancels.reduce(
    (total, cancel) => total + cancel.cancelAmount,
    0,
  );
  const refundedAt = cancels
    .map((cancel) => cancel.canceledAt)
    .filter((value): value is string => Boolean(value))
    .sort()
    .at(-1);
  return {
    refundedAmount,
    refundedAt: refundedAt ? new Date(refundedAt) : null,
    full: refundedAmount >= amount,
  };
}

export type ReconciliationResult =
  | { state: "done" }
  | { state: "pending" }
  | { state: "failed"; status: string }
  | { state: "refunded"; amount: number; full: boolean }
  | { state: "expired" };

async function reconcilePaymentCore(
  paymentId: number,
): Promise<ReconciliationResult> {
  const payment = await db
    .selectFrom("payments")
    .selectAll()
    .where("id", "=", paymentId)
    .executeTakeFirstOrThrow();

  const refreshable = new Set(["pending", "done", "partial_canceled"]);
  if (!refreshable.has(payment.status)) {
    return { state: "failed", status: payment.status };
  }

  let tossPayment;
  try {
    tossPayment = await getPaymentByOrderId(payment.order_id);
  } catch (error) {
    if (error instanceof TossApiError && error.status === 404) {
      if (
        payment.status === "pending" &&
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
      const { refundedAmount, refundedAt, full } = refundDetails(
        tossPayment,
        payment.amount,
      );

      await db.transaction().execute(async (trx) => {
        await trx
          .updateTable("payments")
          .set({
            toss_payment_key: tossPayment.paymentKey,
            status,
            refunded_amount: refundedAmount,
            refunded_at: refundedAt,
            raw: JSON.stringify(tossPayment),
          })
          .where("id", "=", payment.id)
          .execute();

        // Lenient policy: never shorten supporter_until. A full refund only
        // stops future charges; the already granted period remains available.
        if (full && payment.subscription_id) {
          await trx
            .updateTable("subscriptions")
            .set({
              status: "canceled",
              toss_billing_key: null,
              next_billing_at: null,
              charging_started_at: null,
              canceled_at: refundedAt ?? new Date(),
              updated_at: new Date(),
            })
            .where("id", "=", payment.subscription_id)
            .execute();
        }
      });
      if (status === "canceled" || status === "partial_canceled") {
        return { state: "refunded", amount: refundedAmount, full };
      }
      return { state: "failed", status };
    }
    return { state: "pending" };
  }

  if (payment.status !== "pending") return { state: "done" };

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

export async function reconcilePayment(
  paymentId: number,
): Promise<ReconciliationResult> {
  try {
    const result = await reconcilePaymentCore(paymentId);
    await db
      .updateTable("payments")
      .set({ last_reconciled_at: new Date(), reconciliation_error: null })
      .where("id", "=", paymentId)
      .execute();
    return result;
  } catch (error) {
    const message = (
      error instanceof Error ? error.message : String(error)
    ).slice(0, 2000);
    try {
      await db
        .updateTable("payments")
        .set({
          last_reconciled_at: new Date(),
          reconciliation_error: message,
        })
        .where("id", "=", paymentId)
        .execute();
    } catch (diagnosticError) {
      console.error(
        `Failed to record reconciliation error for payment ${paymentId}`,
        diagnosticError,
      );
    }
    throw error;
  }
}
