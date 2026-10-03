import {
  ONE_TIME_BLOCKING_STATUSES,
  type PaymentStatus,
} from "@/lib/payments/payment-states";
import { db } from "@/lib/database";
import type { Executor } from "@/lib/entitlements";
import {
  OtherMidError,
  paymentFlowForRecord,
  paymentOfOtherMid,
} from "@/lib/payments/toss";
import { retireUnusedSignupKey } from "@/lib/payments/subscriptions";
import { withAccountLock } from "@/lib/payments/account-lock";
import { lookupOrder } from "@/lib/payments/toss-gateway";
import { deleteRetiredBillingKey } from "@/lib/payments/billing-keys";
import { recordPaymentEvent, won } from "@/lib/payments/payment-events";
import { enqueueOneTimeConfirmation } from "@/lib/payments/one-time-payments";
import { applyVerifiedTossPayment } from "@/lib/payments/payment-facts";

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
  // How long to wait for the account lock (lib/payments/account-lock): 0 for the
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
    (payment.status === "canceled" && payment.refunded_amount < payment.amount);
  if (!refreshable) {
    return { state: "failed", status: payment.status };
  }
  // Out of the current key's reach: nothing to ask Toss.
  const otherMid = paymentOfOtherMid(payment);
  if (otherMid) throw otherMid;

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
  const tossPayment = found.payment;

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
    await enqueueOneTimeConfirmation(payment.id, tossPayment.paymentKey);
  }
  const result = await applyVerifiedTossPayment(payment.id, tossPayment);
  if (!opts.deferKeyDeletion) await deleteRetiredBillingKey(result.retiredKey);
  if (result.state === "done" || result.state === "pending")
    return { state: result.state };
  const { retiredKey: _, ...outcome } = result;
  return outcome;
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

// The account's orders whose outcome is still unknown (pending): its plans'
// charges, and its one-time orders. What "open" means is decided here once;
// every check that waits for open orders goes through these.
export function openRecurringOrders(executor: Executor, userId: string) {
  return executor
    .selectFrom("payments")
    .where("user_id", "=", userId)
    .where("subscription_id", "is not", null)
    .where("status", "=", "pending");
}

export function openOneTimeOrders(executor: Executor, userId: string) {
  return executor
    .selectFrom("payments")
    .where("user_id", "=", userId)
    .where("attempt_key", "like", "one_time:%")
    .where("status", "=", "pending");
}

// Settles the account's recurring orders whose outcome is still unknown.
// False while one remains: a new card, a one-time purchase or an account
// deletion must not go ahead while one of them might yet turn out charged —
// the pending order's id and idempotency key belong to the old card and
// amount, and a late success has to land on its plan first. Callers hold the
// account lock, which reconciliation takes too.
export async function settlePendingCharges(userId: string): Promise<boolean> {
  const open = () => openRecurringOrders(db, userId).select("id");
  for (const payment of await open().execute()) {
    await reconcilePayment(payment.id).catch((error) =>
      console.error(`Settling recurring order ${payment.id} failed`, error),
    );
  }
  return (await open().executeTakeFirst()) == null;
}

// Settles the account's pending one-time orders before a new purchase is
// decided: one the buyer authenticated is queued for confirmation unless superseded,
// one Toss approved is granted. False when one may still be approved — its
// confirm is still running at Toss, so it would land beside whatever is
// bought now: a second year, or a new plan switched straight off. An order
// Toss never saw (a closed payment window) does not count, nor one past the
// window in which Toss could still approve it. Callers hold the account lock.
export async function settleOneTimeOrders(userId: string): Promise<boolean> {
  const pending = () =>
    openOneTimeOrders(db, userId)
      .select([
        "id",
        "user_id",
        "created_at",
        "charge_attempted_at",
        "raw",
        "toss_payment_key",
      ])
      .execute();
  for (const payment of await pending()) {
    await reconcilePayment(payment.id).catch((error) =>
      console.error(`Settling one-time order ${payment.id} failed`, error),
    );
  }
  for (const payment of await pending()) {
    const tossStatus = storedTossStatus(payment.raw);
    if (
      (tossStatus === "IN_PROGRESS" || payment.toss_payment_key != null) &&
      Date.now() - lastAttemptAt(payment).getTime() <= UNCONFIRMED_EXPIRY_MS &&
      (payment.charge_attempted_at != null ||
        !(await oneTimeOrderSuperseded(payment)))
    ) {
      return false;
    }
  }
  return true;
}

// Asks Toss what became of a payment and brings the ledger, the account's
// paid time and its plan in line. Runs under the account's lock
// (lib/payments/account-lock), waiting opts.waitMs (default 5 s) for it; throws
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
      // row whose lookup failed stays due for the refund sweep — unless it
      // is another MID's, which no later lookup will reach either: counted
      // as checked, it waits its turn like any other paid row.
      const checked = error instanceof OtherMidError;
      await db
        .updateTable("payments")
        .set((eb) => ({
          reconciliation_error: message,
          last_reconciled_at: checked
            ? new Date()
            : eb
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
    .select([
      "id",
      "order_id",
      "amount",
      "status",
      "toss_flow",
      "attempt_key",
      "toss_mid",
    ])
    .where("id", "=", paymentId)
    .executeTakeFirstOrThrow();
  if (!RECOVERABLE_STATUSES.includes(payment.status)) {
    throw new RecoveryError(
      `${payment.status} 상태의 결제는 복구 대상이 아닙니다.`,
    );
  }
  const otherMid = paymentOfOtherMid(payment);
  if (otherMid) throw new RecoveryError(otherMid.message);

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
