import { randomUUID } from "crypto";
import {
  isOneOf,
  LIVE_SUBSCRIPTION_STATUSES,
  ONE_TIME_BLOCKING_STATUSES,
  type PaymentStatus,
} from "@/lib/payment-states";
import { db } from "@/lib/database";
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
import type { Executor } from "@/lib/entitlements";
import {
  applyOneTimePayment,
  applySuccessfulCharge,
  endPlan,
  retireUnusedSignupKey,
} from "@/lib/subscriptions";
import { withAccountLock } from "@/lib/account-lock";
import { confirmOrder, lookupOrder } from "@/lib/toss-gateway";
import { deleteRetiredBillingKey, retireBillingKey } from "@/lib/billing-keys";
import { recordPaymentEvent, won } from "@/lib/payment-events";
import { enqueueJob, runJobs } from "@/lib/payment-jobs";
import { recordCancels } from "@/lib/payment-ledger";
import { lockPaidTime, recomputePaidTime } from "@/lib/paid-time";

// An order Toss has never heard of is given up after this long. A one-time
// order exists at Toss only once the buyer has opened the payment window,
// which stays open for 30 minutes, and an authenticated payment then has 10
// more to be confirmed: an order counted from its prepare must outlast both.
export const UNCONFIRMED_EXPIRY_MS = 45 * 60 * 1000;


export type ReconciliationResult =
  | { state: "done" }
  | { state: "pending" }
  | { state: "failed"; status: string }
  | {
      state: "refunded";
      amount: number;
      // This reconciliation found the refund and stopped the account's
      // recurring billing because of it.
      subscriptionCanceled: boolean;
    }
  | { state: "expired" };

// When the order was last sent to Toss, or made if it never was. An order
// Toss has not heard of is expired UNCONFIRMED_EXPIRY_MS after this: a charge
// that timed out may still be approved by Toss after the lock was let go, and
// a reused order's creation can be a day old.
export function lastAttemptAt(payment: {
  created_at: Date | string;
  charge_attempted_at: Date | string | null;
}): Date {
  const created = new Date(payment.created_at);
  const attempted = payment.charge_attempted_at
    ? new Date(payment.charge_attempted_at)
    : null;
  return attempted && attempted > created ? attempted : created;
}

export type ReconcileOptions = {
  // How long to wait for the account lock (lib/account-lock): 0 for the
  // background jobs, which skip a busy account until their next run.
  waitMs?: number;
  // Leave a key this retires queued for the delete-retired-billing-keys cron
  // (every 5 minutes) instead of deleting it at Toss now. A webhook must answer
  // within 10 seconds, and the delete may wait out the whole Toss timeout.
  deferKeyDeletion?: boolean;
};

async function reconcilePaymentCore(
  paymentId: string,
  opts: ReconcileOptions,
): Promise<ReconciliationResult> {
  const payment = await db
    .selectFrom("payments")
    .selectAll()
    .where("id", "=", paymentId)
    .executeTakeFirstOrThrow();

  // A canceled payment is looked at again only while Toss may still give
  // more of it back (a partial cancel from the dashboard).
  const refreshable =
    payment.status === "pending" ||
    payment.status === "done" ||
    (payment.status === "canceled" &&
      payment.refunded_amount < payment.amount);
  if (!refreshable) {
    return { state: "failed", status: payment.status };
  }

  // A signup's first charge that went nowhere leaves the signup's key with
  // nothing to charge; retireUnusedSignupKey decides whether it is still in use.
  const initialAttempt =
    payment.subscription_id != null &&
    (payment.attempt_key?.startsWith("subscription_initial:") ?? false);

  const found = await lookupOrder(
    payment.order_id,
    paymentFlowForRecord(payment.toss_flow, payment.attempt_key),
  );
  if (found.kind === "unknown") throw found.error;
  if (found.kind === "not_found") {
    // Under the account lock no charge of this order is in flight here, and
    // the last one sent has had UNCONFIRMED_EXPIRY_MS to reach Toss.
    if (
      payment.status === "pending" &&
      Date.now() - lastAttemptAt(payment).getTime() > UNCONFIRMED_EXPIRY_MS
    ) {
      const outcome = await db.transaction().execute(async (trx) => {
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
        return {
          retiredKey: initialAttempt
            ? await retireUnusedSignupKey(trx, payment.subscription_id!)
            : null,
        };
      });
      if (!opts.deferKeyDeletion) {
        await deleteRetiredBillingKey(outcome.retiredKey);
      }
      return { state: "expired" };
    }
    return { state: "pending" };
  }
  let tossPayment = found.payment;

  if (
    tossPayment.orderId !== payment.order_id ||
    tossPayment.totalAmount !== payment.amount
  ) {
    throw new Error(`Toss payment mismatch for order ${payment.order_id}`);
  }
  if (
    tossPayment.status === "IN_PROGRESS" &&
    payment.status === "pending" &&
    payment.attempt_key?.startsWith("one_time:") &&
    !(await oneTimeOrderSuperseded(payment))
  ) {
    tossPayment = await confirmAuthenticatedPayment(payment, tossPayment);
  }
  // 나루 sells no partial refunds; a partial cancel made in the Toss
  // dashboard undoes the purchase like a full one (supporterUntilFromLedger),
  // so it is recorded as canceled, with the amount Toss gave back.
  const tossStatus = tossPayment.status.toLowerCase();
  const status = tossStatus === "partial_canceled" ? "canceled" : tossStatus;

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
    const finalStatuses: PaymentStatus[] = [
      "canceled",
      "aborted",
      "expired",
      "failed",
    ];
    if (isOneOf(finalStatuses, status)) {
      // Read from the ledger, which keeps each cancel Toss reports once.
      let refundedAmount = 0;
      let refundedAt: Date | null = null;

      const { retiredKey, subscriptionCanceled, noticeJob } = await db
        .transaction()
        .execute(async (trx) => {
          // Read under a lock, so of two reconciliations that see the same
          // refund — the refund call's own and the webhook it set off — only
          // one finds it new.
          const before = await trx
            .selectFrom("payments")
            .select("refunded_amount")
            .where("id", "=", payment.id)
            .forUpdate()
            .executeTakeFirstOrThrow();
          // The user next, before the ledger is read: a charge granted while
          // this runs holds this lock (payments, users, subscriptions), so its
          // period is in the ledger read below rather than overwritten by a
          // supporter_until recomputed without it.
          await lockPaidTime(trx, payment.user_id);
          ({ refundedAmount, refundedAt } = await recordCancels(trx, {
            paymentId: payment.id,
            payment: tossPayment,
            fallbackAt: new Date(),
          }));
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
          // for. Only when this reconciliation found new refunded money: an
          // order that simply failed or expired paid for nothing and changes
          // nothing.
          const newlyRefunded = refundedAmount > before.refunded_amount;
          const recomputed = newlyRefunded
            ? await recomputePaidTime(trx, payment.user_id)
            : null;

          // A refund ends the billing relationship, not just this one charge:
          // the recurring plan the account had when the money went back must
          // not charge the card again — the refunded renewal's own plan, or
          // one running beside a refunded one-time payment. Done here, the
          // first time the refund is seen, so a refund made in the Toss
          // dashboard or one whose cancel call got no answer stops it as well
          // as one made through refundPayment. Its cancel is told in the
          // refund's own mail.
          //
          // Only a plan that already existed when the refund happened: one the
          // supporter started since — before a late webhook or the refund sweep
          // brought the refund in — is theirs to keep.
          let stopped: { id: string; retiredKey: string | null } | null = null;
          if (newlyRefunded) {
            const refundedBy = refundedAt ?? new Date();
            const live = await trx
              .selectFrom("subscriptions")
              .select("id")
              .where("user_id", "=", payment.user_id)
              .where("status", "in", LIVE_SUBSCRIPTION_STATUSES)
              .where("created_at", "<=", refundedBy)
              .executeTakeFirst();
            const ended = live
              ? await endPlan(trx, live.id, {
                  summary: () => "환불에 따라 정기 결제도 취소",
                  at: refundedBy,
                })
              : null;
            if (live && ended) {
              stopped = { id: live.id, retiredKey: ended.retiredKey };
            }
          }
          // A plan the refund leaves running — one started after the refund —
          // must charge when the paid time it now has ends. Its own dates may
          // still point past that (prepaid time a scheduled start waited for),
          // and left there it shows as running while access is gone. Pulled
          // back, never pushed out; with no paid time left it is charged on
          // the next run.
          if (newlyRefunded && !stopped) {
            const due =
              recomputed && recomputed > new Date() ? recomputed : new Date();
            await trx
              .updateTable("subscriptions")
              .set({
                current_period_end: due,
                next_billing_at: due,
                updated_at: new Date(),
              })
              .where("user_id", "=", payment.user_id)
              .where("status", "in", ["active", "scheduled"])
              .where("next_billing_at", ">", due)
              .execute();
          }
          if (newlyRefunded) {
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

          // Enqueued with the refund it reports, once per refunded amount.
          const noticeJob = newlyRefunded
            ? await enqueueJob(
                trx,
                {
                  kind: "payment_canceled",
                  paymentId: payment.id,
                  subscriptionCanceled: !!stopped,
                },
                {
                  dedupeKey: `payment_canceled:${payment.id}:${refundedAmount}`,
                },
              )
            : null;

          if (stopped) {
            return {
              noticeJob,
              subscriptionCanceled: true,
              retiredKey: stopped.retiredKey,
            };
          }
          if (initialAttempt && refundedAmount === 0) {
            return {
              noticeJob,
              subscriptionCanceled: false,
              retiredKey: await retireUnusedSignupKey(
                trx,
                payment.subscription_id!,
              ),
            };
          }
          return {
            noticeJob,
            subscriptionCanceled: false,
            retiredKey: null,
          };
        });
      if (!opts.deferKeyDeletion) await deleteRetiredBillingKey(retiredKey);
      await runJobs([noticeJob]);
      if (status === "canceled") {
        return {
          state: "refunded",
          amount: refundedAmount,
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
    // The buyer's own confirm never got this far — they left before the
    // callback ran, or it failed — so the grant's thank-you is theirs.
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

  // The charge's own run left it unresolved, so nobody has told the
  // supporter about it yet: a receipt goes with the grant.
  await applySuccessfulCharge({
    subscriptionId: payment.subscription_id,
    userId: payment.user_id,
    interval: subscription.billing_interval as BillingInterval,
    amount: payment.amount,
    from,
    payment: tossPayment,
    paymentId: payment.id,
    notice: "receipt",
  });
  return { state: "done" };
}

// True when this one-time order should not be approved: another one-time
// payment of the same account was paid after it was prepared — by a second
// tab, or by paying again after a confirm that looked stuck — or a recurring
// plan is running (one-time purchases are not offered beside one). Such an
// order is not approved; Toss lets the authentication lapse, so the card is
// not charged. A one-time purchase made deliberately after another completes
// is prepared after it, and goes ahead.
export async function oneTimeOrderSuperseded(payment: {
  id: string;
  user_id: string;
  created_at: Date | string;
}): Promise<boolean> {
  const runningPlan = await db
    .selectFrom("subscriptions")
    .select("id")
    .where("user_id", "=", payment.user_id)
    .where("status", "in", ONE_TIME_BLOCKING_STATUSES)
    .executeTakeFirst();
  if (runningPlan) return true;
  const other = await db
    .selectFrom("payments")
    .select("id")
    .where("user_id", "=", payment.user_id)
    .where("id", "!=", payment.id)
    .where("attempt_key", "like", "one_time:%")
    .where("status", "=", "done")
    .where("paid_at", ">=", new Date(payment.created_at))
    .executeTakeFirst();
  return other != null;
}

// The Toss status the last lookup stored on a payment row (payments.raw).
function storedTossStatus(raw: unknown): unknown {
  let value = raw;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  return value && typeof value === "object"
    ? (value as { status?: unknown }).status
    : null;
}

// Settles the account's pending one-time orders before a new purchase is
// decided: one the buyer authenticated is confirmed (or not, if superseded),
// one Toss approved is granted. False when one may still be approved — its
// confirm is still running at Toss, so it would land beside whatever is
// bought now: a second year, or a new plan switched straight off. An order
// Toss never saw (a closed payment window) does not count, nor one past the
// window in which Toss could still approve it. Callers hold the account lock.
export async function settleOneTimeOrders(userId: string): Promise<boolean> {
  const pending = () =>
    db
      .selectFrom("payments")
      .select(["id", "user_id", "created_at", "charge_attempted_at", "raw"])
      .where("user_id", "=", userId)
      .where("attempt_key", "like", "one_time:%")
      .where("status", "=", "pending")
      .execute();
  for (const payment of await pending()) {
    await reconcilePayment(payment.id).catch((error) =>
      console.error(`Settling one-time order ${payment.id} failed`, error),
    );
  }
  for (const payment of await pending()) {
    const tossStatus = storedTossStatus(payment.raw);
    if (
      tossStatus === "IN_PROGRESS" &&
      Date.now() - lastAttemptAt(payment).getTime() <= UNCONFIRMED_EXPIRY_MS &&
      !(await oneTimeOrderSuperseded(payment))
    ) {
      return false;
    }
  }
  return true;
}

// A one-time payment the buyer authenticated but nobody confirmed: they
// closed the tab before the callback ran, or its confirm failed in a way that
// left the payment open. Toss expires it 10 minutes after authentication, so
// the reconciler confirms it itself, for the amount recorded at prepare.
//
// Under a key of its own, not the order id the callback's first confirm used:
// Toss keys idempotency on the key, the secret key, the URL and the method, so
// that key would only replay the callback's answer — an error, or the payment
// would not still be IN_PROGRESS — until the 10 minutes ran out. A new key
// cannot approve the payment twice: Toss refuses a second approval
// (ALREADY_PROCESSED_PAYMENT), and one still running (ALREADY_PROCESSING_
// REQUEST). Anything but an approval leaves the payment as Toss reported it,
// to be settled when Toss moves it on.
async function confirmAuthenticatedPayment(
  payment: { id: string; order_id: string; amount: number },
  inProgress: TossPaymentResult,
): Promise<TossPaymentResult> {
  const outcome = await confirmOrder({
    paymentKey: inProgress.paymentKey,
    orderId: payment.order_id,
    amount: payment.amount,
    firstKey: `${payment.order_id}:${randomUUID()}`,
    retryOnce: false,
    beforeSend: async () => {
      await db
        .updateTable("payments")
        .set({ charge_attempted_at: new Date() })
        .where("id", "=", payment.id)
        .execute();
    },
  });
  if (outcome.kind === "approved") return outcome.payment;
  if (outcome.kind === "declined" && outcome.payment) return outcome.payment;
  console.error(
    `Reconciling payment ${payment.id}: confirming the authenticated payment did not approve it: ${describeTossError(outcome.error)}`,
  );
  return inProgress;
}

// Asks Toss what became of a payment and brings the ledger, the account's
// paid time and its plan in line. Runs under the account's lock
// (lib/account-lock), waiting opts.waitMs (default 5 s) for it; throws
// AccountBusyError when another payment operation holds it.
export async function reconcilePayment(
  paymentId: string,
  opts: ReconcileOptions = {},
): Promise<ReconciliationResult> {
  const owner = await db
    .selectFrom("payments")
    .select("user_id")
    .where("id", "=", paymentId)
    .executeTakeFirstOrThrow();
  return withAccountLock(owner.user_id, { waitMs: opts.waitMs ?? 5000 }, () =>
    reconcileLocked(paymentId, opts),
  );
}

async function reconcileLocked(
  paymentId: string,
  opts: ReconcileOptions,
): Promise<ReconciliationResult> {
  try {
    const result = await reconcilePaymentCore(paymentId, opts);
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
      // The error is recorded; the check is counted only for a pending row,
      // which the reconciler visits least recently checked first. A paid
      // row whose lookup failed stays due for the refund sweep.
      await db
        .updateTable("payments")
        .set((eb) => ({
          reconciliation_error: message,
          last_reconciled_at: eb
            .case()
            .when("status", "=", "pending")
            .then(new Date())
            .else(eb.ref("last_reconciled_at"))
            .end(),
        }))
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

// The ledger states a charge can be orphaned under: an order settled as
// expired, failed or declined that Toss nonetheless approved (charge_orphaned).
// Nothing looks at these rows again on its own.
export const RECOVERABLE_STATUSES: PaymentStatus[] = [
  "expired",
  "failed",
  "aborted",
];

export type RecoveryResult =
  | { state: "recovered"; result: ReconciliationResult }
  | { state: "not_paid"; tossStatus: string | null };

export class RecoveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RecoveryError";
  }
}

// An operator's fix for an orphaned charge: if Toss says the order was paid,
// the row goes back to pending and the ordinary reconciliation grants it —
// the period, the receipt, a one-time purchase's switch from recurring — as if
// the charge had landed normally. A paid row can then be refunded like any
// other, if refunding is the right call (the supporter was also charged for a
// retry, say). An order Toss did not complete is left as it is.
export async function recoverOrphanedCharge(
  paymentId: string,
): Promise<RecoveryResult> {
  const owner = await db
    .selectFrom("payments")
    .select("user_id")
    .where("id", "=", paymentId)
    .executeTakeFirstOrThrow();
  return withAccountLock(owner.user_id, { waitMs: 10_000 }, () =>
    recoverLocked(paymentId),
  );
}

async function recoverLocked(paymentId: string): Promise<RecoveryResult> {
  const payment = await db
    .selectFrom("payments")
    .select(["id", "order_id", "amount", "status", "toss_flow", "attempt_key"])
    .where("id", "=", paymentId)
    .executeTakeFirstOrThrow();
  if (!RECOVERABLE_STATUSES.includes(payment.status)) {
    throw new RecoveryError(
      `${payment.status} 상태의 결제는 복구 대상이 아닙니다.`,
    );
  }

  const found = await lookupOrder(
    payment.order_id,
    paymentFlowForRecord(payment.toss_flow, payment.attempt_key),
  );
  if (found.kind === "not_found")
    return { state: "not_paid", tossStatus: null };
  if (found.kind === "unknown") throw found.error;
  const tossPayment = found.payment;
  if (
    tossPayment.orderId !== payment.order_id ||
    tossPayment.totalAmount !== payment.amount
  ) {
    throw new RecoveryError(
      `Toss 결제가 주문과 맞지 않습니다 (금액 ${tossPayment.totalAmount}/${payment.amount}).`,
    );
  }
  if (tossPayment.status !== "DONE") {
    return { state: "not_paid", tossStatus: tossPayment.status };
  }

  const reopened = await db
    .updateTable("payments")
    .set({ status: "pending", reconciliation_error: null })
    .where("id", "=", payment.id)
    .where("status", "in", RECOVERABLE_STATUSES)
    .executeTakeFirst();
  if (Number(reopened.numUpdatedRows ?? 0) === 0) {
    throw new RecoveryError(
      "결제 상태가 그사이 바뀌었습니다. 다시 확인해 주세요.",
    );
  }
  console.log(
    `[payments] recovering orphaned charge: payment ${payment.id} (${payment.status}) is DONE at Toss`,
  );
  return { state: "recovered", result: await reconcilePayment(payment.id) };
}
