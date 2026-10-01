import { sendChargeReceipt } from "@/lib/charge-receipts";
import { db } from "@/lib/database";
import { sendSupportThankYouEmail } from "@/lib/email";
import {
  BillingInterval,
  confirmPayment,
  describeTossError,
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

// An order Toss has never heard of is given up after this long. A one-time
// order exists at Toss only once the buyer has opened the payment window,
// which stays open for 30 minutes, and an authenticated payment then has 10
// more to be confirmed: an order counted from its prepare must outlast both.
export const UNCONFIRMED_EXPIRY_MS = 45 * 60 * 1000;

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
  | {
      state: "refunded";
      amount: number;
      full: boolean;
      // This reconciliation found the refund and stopped the account's
      // recurring billing because of it.
      subscriptionCanceled: boolean;
    }
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

  let tossPayment: TossPaymentResult;
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

  if (
    tossPayment.orderId !== payment.order_id ||
    tossPayment.totalAmount !== payment.amount
  ) {
    throw new Error(`Toss payment mismatch for order ${payment.order_id}`);
  }
  if (
    tossPayment.status === "IN_PROGRESS" &&
    payment.status === "pending" &&
    payment.attempt_key?.startsWith("one_time:")
  ) {
    tossPayment = await confirmAuthenticatedPayment(payment, tossPayment);
  }
  const status = tossPayment.status.toLowerCase();

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

      const { retiredKey, subscriptionCanceled } = await db
        .transaction()
        .execute(async (trx) => {
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

          // A refund ends the billing relationship, not just this one charge:
          // whatever recurring plan the account has must not charge the card
          // again — the refunded renewal's own subscription, or, for a refunded
          // one-time payment, a plan started since. Done here, the first time
          // the refund is seen, so a refund made in the Toss dashboard or one
          // whose cancel call got no answer stops it as well as one made
          // through refundPayment. Only then: a payment reconciled again later
          // must not cancel a plan the supporter started after the refund.
          const newlyRefunded = refundedAmount > payment.refunded_amount;
          let stopped: { id: string } | undefined;
          if (newlyRefunded) {
            stopped = await trx
              .updateTable("subscriptions")
              .set({
                status: "canceled",
                next_billing_at: null,
                charging_started_at: null,
                canceled_at: refundedAt ?? new Date(),
                updated_at: new Date(),
              })
              .where("user_id", "=", payment.user_id)
              .where("status", "not in", ["canceled", "switched_to_one_time"])
              .returning("id")
              .executeTakeFirst();
            await recordPaymentEvent(trx, {
              kind: "refunded",
              userId: payment.user_id,
              paymentId: payment.id,
              subscriptionId: payment.subscription_id ?? stopped?.id,
              summary: `환불 ${won(refundedAmount)} / ${won(payment.amount)} (주문 ${payment.order_id}) · 이용 기한은 ${recomputed ? recomputed.toISOString().slice(0, 10) : "없음"}으로 다시 계산${stopped ? " · 정기 결제 취소" : ""}`,
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

          if (stopped) {
            return {
              subscriptionCanceled: true,
              retiredKey: await retireBillingKey(trx, {
                subscriptionId: stopped.id,
              }),
            };
          }
          if (initialAttempt && refundedAmount === 0) {
            return {
              subscriptionCanceled: false,
              retiredKey: await retireUnusedSignupKey(
                trx,
                payment.subscription_id!,
              ),
            };
          }
          return { subscriptionCanceled: false, retiredKey: null };
        });
      await deleteRetiredBillingKey(retiredKey);
      if (status === "canceled" || status === "partial_canceled") {
        return {
          state: "refunded",
          amount: refundedAmount,
          full,
          subscriptionCanceled,
        };
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
    const period = await applyOneTimePayment({
      userId: payment.user_id,
      amount: payment.amount,
      years,
      payment: tossPayment,
      paymentId: payment.id,
    });
    // The buyer's own confirm never got this far — they left before the
    // callback ran, or it failed — so nobody has thanked them yet.
    if (period.granted) {
      await sendOneTimeThankYou(
        payment.user_id,
        payment.amount,
        period.periodEnd,
      );
    }
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

  const { granted } = await applySuccessfulCharge({
    subscriptionId: payment.subscription_id,
    userId: payment.user_id,
    interval: subscription.billing_interval as BillingInterval,
    amount: payment.amount,
    from,
    payment: tossPayment,
    paymentId: payment.id,
  });
  // The charge's own run left it unresolved, so nobody has told the
  // supporter about it yet.
  if (granted) await sendChargeReceipt(payment.id);
  return { state: "done" };
}

// A one-time payment the buyer authenticated but nobody confirmed: they
// closed the tab before the callback ran, or its confirm failed in a way that
// left the payment open. Toss expires it 10 minutes after authentication, so
// the reconciler confirms it itself, for the amount recorded at prepare —
// under the order's own idempotency key, the one the callback uses, so the two
// can never both approve it. Anything but an approval leaves the payment as
// Toss reported it, to be settled when Toss moves it on.
async function confirmAuthenticatedPayment(
  payment: { id: string; order_id: string; amount: number },
  inProgress: TossPaymentResult,
): Promise<TossPaymentResult> {
  try {
    const confirmed = await confirmPayment(
      {
        paymentKey: inProgress.paymentKey,
        orderId: payment.order_id,
        amount: payment.amount,
      },
      payment.order_id,
    );
    if (
      confirmed.orderId === payment.order_id &&
      confirmed.totalAmount === payment.amount
    ) {
      return confirmed;
    }
  } catch (error) {
    console.error(
      `Reconciling payment ${payment.id}: confirming the authenticated payment failed: ${describeTossError(error)}`,
    );
  }
  return inProgress;
}

async function sendOneTimeThankYou(
  userId: string,
  amount: number,
  supporterUntil: Date,
) {
  try {
    const user = await db
      .selectFrom("users")
      .select(["email", "email_verified_at", "login_name"])
      .where("id", "=", userId)
      .executeTakeFirst();
    if (!user?.email || !user.email_verified_at) return;
    await sendSupportThankYouEmail({
      email: user.email,
      loginName: user.login_name,
      kind: "one_time",
      amount,
      supporterUntil,
    });
  } catch (error) {
    console.error("Support thank-you email error:", error);
  }
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
