import { db } from "@/lib/database";
import {
  BillingInterval,
  getPaymentByOrderId,
  oneTimeYearsForAmount,
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

export type EntitlementLedgerRow = {
  periodEnd: Date | string | null;
  amount: number;
  refundedAmount: number;
};

// supporter_until is the end of the latest period a payment actually paid for.
// A fully refunded payment stops counting, so the time it granted goes with the
// money. Partial refunds still count: they are normally a goodwill gesture, and
// slicing a proportional piece off a stack of periods has no honest answer.
export function supporterUntilFromLedger(
  rows: EntitlementLedgerRow[],
): Date | null {
  let latest: Date | null = null;
  for (const row of rows) {
    if (!row.periodEnd) continue;
    if (row.refundedAmount >= row.amount) continue;
    const end = new Date(row.periodEnd);
    if (!latest || end > latest) latest = end;
  }
  return latest;
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

        // Refunding takes back the time the refunded money paid for. Without
        // this a chargeback bought a free supporter year: the money went back
        // and the entitlement stayed. Recomputed from the ledger rather than
        // subtracted, so a refund cannot disturb periods other payments paid
        // for.
        const ledger = await trx
          .selectFrom("payments")
          .select(["period_end", "amount", "refunded_amount"])
          .where("user_id", "=", payment.user_id)
          .where("period_end", "is not", null)
          .execute();
        const recomputed = supporterUntilFromLedger(
          ledger.map((row) => ({
            periodEnd: row.period_end,
            amount: row.amount,
            refundedAmount: row.refunded_amount,
          })),
        );
        const currentUser = await trx
          .selectFrom("users")
          .select("supporter_until")
          .where("id", "=", payment.user_id)
          .executeTakeFirst();
        const currentUntil = currentUser?.supporter_until
          ? new Date(currentUser.supporter_until)
          : null;
        // Only ever shortens. Lifetime comps live on supporter_comp and are
        // untouched by this.
        if (
          currentUntil &&
          (recomputed === null || recomputed < currentUntil)
        ) {
          await trx
            .updateTable("users")
            .set({ supporter_until: recomputed })
            .where("id", "=", payment.user_id)
            .execute();
        }

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
    const years = oneTimeYearsForAmount(payment.amount);
    if (years === null) {
      throw new Error(`Payment ${payment.id} has an invalid one-time amount`);
    }
    await applyOneTimePayment({
      userId: payment.user_id,
      amount: payment.amount,
      years,
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
