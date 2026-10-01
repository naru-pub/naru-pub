import { db } from "@/lib/database";
import {
  BillingInterval,
  getPaymentByOrderId,
  oneTimeYearsForAmount,
  paymentFlowForRecord,
  paymentProviderMetadata,
  TossApiError,
  TossPaymentResult,
} from "@/lib/toss";
import {
  applyOneTimePayment,
  applySuccessfulCharge,
  retireUnusedSignupKey,
} from "@/lib/subscriptions";
import { deleteRetiredBillingKey, retireBillingKey } from "@/lib/billing-keys";
import { recordPaymentEvent, won } from "@/lib/payment-events";

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
  periodStart?: Date | string | null;
  periodEnd: Date | string | null;
  paidAt?: Date | string | null;
  amount: number;
  refundedAmount: number;
};

// supporter_until is where the periods the unrefunded payments bought end. A
// refunded payment stops counting, so the time it granted goes back with the
// money. 나루 does not offer partial refunds, so any refunded amount undoes the
// whole purchase rather than a slice of it.
//
// Purchases stack: one bought while time remained starts where that time ended.
// So the ledger is replayed in order, and a period that was queued behind a
// refunded one moves up — but never earlier than it was paid for, and never
// later than it was recorded. A period that did not stack keeps its dates.
export function supporterUntilFromLedger(
  rows: EntitlementLedgerRow[],
): Date | null {
  const periods = rows
    .filter((row) => row.periodEnd)
    .map((row) => ({
      start: row.periodStart ? new Date(row.periodStart) : null,
      end: new Date(row.periodEnd!),
      paidAt: row.paidAt ? new Date(row.paidAt) : null,
      refunded: row.refundedAmount > 0,
    }))
    .sort(
      (a, b) =>
        (a.start ?? a.end).getTime() - (b.start ?? b.end).getTime() ||
        a.end.getTime() - b.end.getTime(),
    );

  let cursor: Date | null = null;
  let latest: Date | null = null;
  for (const period of periods) {
    if (period.refunded) continue;
    let end = period.end;
    if (period.start && period.paidAt) {
      const earliest =
        cursor && cursor > period.paidAt ? cursor : period.paidAt;
      if (earliest < period.start) {
        end = new Date(
          period.end.getTime() - (period.start.getTime() - earliest.getTime()),
        );
      }
    }
    if (!cursor || end > cursor) cursor = end;
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
  paymentId: string,
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

  // A signup's first charge that went nowhere leaves the signup's key with
  // nothing to charge; retireUnusedSignupKey decides whether it is still in use.
  const initialAttempt =
    payment.subscription_id != null &&
    (payment.attempt_key?.startsWith("subscription_initial:") ?? false);

  let tossPayment;
  try {
    tossPayment = await getPaymentByOrderId(
      payment.order_id,
      paymentFlowForRecord(payment.toss_flow, payment.attempt_key),
    );
  } catch (error) {
    if (error instanceof TossApiError && error.status === 404) {
      if (
        payment.status === "pending" &&
        Date.now() - new Date(payment.created_at).getTime() >
          UNCONFIRMED_EXPIRY_MS
      ) {
        const retiredKey = await db.transaction().execute(async (trx) => {
          const expired = await trx
            .updateTable("payments")
            .set({ status: "expired" })
            .where("id", "=", payment.id)
            .where("status", "=", "pending")
            .executeTakeFirst();
          if (Number(expired.numUpdatedRows ?? 0) > 0) {
            await recordPaymentEvent(trx, {
              kind: "order_expired",
              userId: payment.user_id,
              paymentId: payment.id,
              subscriptionId: payment.subscription_id,
              summary: `주문 ${payment.order_id} (${won(payment.amount)})이 Toss에 없어 만료 처리${initialAttempt ? " · 가입에 등록한 카드는 폐기" : ""}`,
            });
          }
          return initialAttempt
            ? retireUnusedSignupKey(trx, payment.subscription_id!)
            : null;
        });
        await deleteRetiredBillingKey(retiredKey);
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

  // Persist the provider's current transaction identity even when the ledger
  // was already marked done; this backfills MID data for historic rows during
  // normal reconciliation.
  await db
    .updateTable("payments")
    .set({
      ...paymentProviderMetadata(
        tossPayment,
        paymentFlowForRecord(payment.toss_flow, payment.attempt_key),
      ),
      toss_payment_key: tossPayment.paymentKey,
      raw: JSON.stringify(tossPayment),
    })
    .where("id", "=", payment.id)
    .execute();

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

      const retiredKey = await db.transaction().execute(async (trx) => {
        await trx
          .updateTable("payments")
          .set({
            ...paymentProviderMetadata(
              tossPayment,
              paymentFlowForRecord(payment.toss_flow, payment.attempt_key),
            ),
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
          .select([
            "period_start",
            "period_end",
            "paid_at",
            "amount",
            "refunded_amount",
          ])
          .where("user_id", "=", payment.user_id)
          .where("period_end", "is not", null)
          .execute();
        const recomputed = supporterUntilFromLedger(
          ledger.map((row) => ({
            periodStart: row.period_start,
            periodEnd: row.period_end,
            paidAt: row.paid_at,
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

        if (refundedAmount > payment.refunded_amount) {
          await recordPaymentEvent(trx, {
            kind: "refunded",
            userId: payment.user_id,
            paymentId: payment.id,
            subscriptionId: payment.subscription_id,
            summary: `환불 ${won(refundedAmount)} / ${won(payment.amount)} (주문 ${payment.order_id}) · 이용 기한은 ${recomputed ? recomputed.toISOString().slice(0, 10) : "없음"}으로 다시 계산${payment.subscription_id ? " · 정기 결제 취소" : ""}`,
          });
        } else if (status !== payment.status && refundedAmount === 0) {
          await recordPaymentEvent(trx, {
            kind: status === "expired" ? "order_expired" : "charge_failed",
            userId: payment.user_id,
            paymentId: payment.id,
            subscriptionId: payment.subscription_id,
            summary: `주문 ${payment.order_id} (${won(payment.amount)}): Toss 상태 ${tossPayment.status}`,
          });
        }

        if (refundedAmount > 0 && payment.subscription_id) {
          await trx
            .updateTable("subscriptions")
            .set({
              status: "canceled",
              next_billing_at: null,
              charging_started_at: null,
              canceled_at: refundedAt ?? new Date(),
              updated_at: new Date(),
            })
            .where("id", "=", payment.subscription_id)
            .execute();
          return retireBillingKey(trx, {
            subscriptionId: payment.subscription_id,
          });
        }
        if (initialAttempt && refundedAmount === 0) {
          return retireUnusedSignupKey(trx, payment.subscription_id!);
        }
        return null;
      });
      await deleteRetiredBillingKey(retiredKey);
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
    .select(["billing_interval", "current_period_end"])
    .where("id", "=", payment.subscription_id)
    .where("user_id", "=", payment.user_id)
    .executeTakeFirstOrThrow();
  const now = new Date();
  const currentEnd = subscription.current_period_end
    ? new Date(subscription.current_period_end)
    : now;
  const from = initialAttempt || currentEnd < now ? now : currentEnd;

  await applySuccessfulCharge({
    subscriptionId: payment.subscription_id,
    userId: payment.user_id,
    interval: subscription.billing_interval as BillingInterval,
    amount: payment.amount,
    from,
    payment: tossPayment,
    paymentId: payment.id,
  });
  return { state: "done" };
}

export async function reconcilePayment(
  paymentId: string,
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
