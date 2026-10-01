import { sql } from "kysely";
import {
  ENDED_SUBSCRIPTION_STATUSES,
  type SubscriptionStatus,
} from "@/lib/payments/payment-states";
import type { SubscriptionCancelReason } from "@/lib/email";
import { extendPaidTime, lockPaidTime } from "@/lib/payments/paid-time";
import { recordApproval } from "@/lib/payments/payment-ledger";
import { enqueueJob, runJobs } from "@/lib/payments/payment-jobs";
import { db } from "@/lib/database";
import { retireBillingKey } from "@/lib/payments/billing-keys";
import type { Executor } from "@/lib/entitlements";
import {
  kstDate,
  notePaymentEvent,
  recordPaymentEvent,
  won,
} from "@/lib/payments/payment-events";
import {
  addInterval,
  addMonths,
  BillingInterval,
  isOneTimeYears,
  paymentProviderMetadata,
  TossPaymentResult,
} from "@/lib/payments/toss";

// A renewal is tried at most once a day. This value is the payment grace window
// before a subscription becomes past_due and related paid-only resources are
// reclaimed.
export const PAYMENT_GRACE_DAYS = 4;
export const MAX_PAYMENT_RETRY_ATTEMPTS = 4;

// Subscriptions that must not be revived by a charge that was already in flight
// when the user (or a refund) stopped them.
const STOPPED_SUBSCRIPTION_STATUSES = ENDED_SUBSCRIPTION_STATUSES;

// An account's plans, newest first. The newest is its current plan: a new
// one is only started after the live one (at most one, by a unique index)
// has ended.
export function plansOf(executor: Executor, userId: string) {
  return executor
    .selectFrom("subscriptions")
    .where("subscriptions.user_id", "=", userId)
    .orderBy("subscriptions.id", "desc");
}

// A join condition that keeps, of the subscriptions joined to users, only
// each account's current plan — for a query that lists accounts.
export const isCurrentPlan = sql<boolean>`subscriptions.id = (
  select current_plan.id from subscriptions current_plan
  where current_plan.user_id = users.id
  order by current_plan.id desc limit 1
)`;

export type EndedPlan = {
  // The status it ended from.
  from: SubscriptionStatus;
  // The key it held, retired: pass to deleteRetiredBillingKey after commit.
  retiredKey: string | null;
  // The cancel mail queued for it: pass to runJobs after commit.
  noticeJob: string | null;
};

// Ends a live plan, the one way every path does it — a cancel, a refund, a
// card deleted at Toss, an account deletion, a new signup replacing it: no
// next charge, its key retired (or recorded deleted, when Toss deleted it),
// an event, and the cancel mail when there is one to send. In the caller's
// transaction, under the account lock. Null when the plan had already ended.
export async function endPlan(
  trx: Executor,
  planId: string,
  opts: {
    summary: (from: SubscriptionStatus) => string;
    // When it ended; now unless the refund that ended it happened earlier.
    at?: Date;
    // The mail to send, if any, by the status it ended from.
    notice?:
      | SubscriptionCancelReason
      | ((from: SubscriptionStatus) => SubscriptionCancelReason);
    keyDeletedAtToss?: boolean;
    eventKind?: "subscription_canceled" | "billing_key_deleted";
  },
): Promise<EndedPlan | null> {
  const plan = await trx
    .selectFrom("subscriptions")
    .select(["user_id", "status"])
    .where("id", "=", planId)
    .forUpdate()
    .executeTakeFirst();
  if (!plan || ENDED_SUBSCRIPTION_STATUSES.includes(plan.status)) return null;
  const now = new Date();
  await trx
    .updateTable("subscriptions")
    .set({
      status: "canceled",
      next_billing_at: null,
      canceled_at: opts.at ?? now,
      updated_at: now,
    })
    .where("id", "=", planId)
    .execute();
  const retiredKey = await retireBillingKey(
    trx,
    { subscriptionId: planId },
    { deletedAtToss: opts.keyDeletedAtToss },
  );
  await recordPaymentEvent(trx, {
    kind: opts.eventKind ?? "subscription_canceled",
    userId: plan.user_id,
    subscriptionId: planId,
    summary: opts.summary(plan.status),
  });
  const reason =
    typeof opts.notice === "function" ? opts.notice(plan.status) : opts.notice;
  const noticeJob = reason
    ? await enqueueJob(
        trx,
        { kind: "subscription_canceled", subscriptionId: planId, reason },
        { dedupeKey: `subscription_canceled:${planId}` },
      )
    : null;
  return { from: plan.status, retiredKey, noticeJob };
}

export function addPaymentGrace(until: Date): Date {
  const graceEndsAt = new Date(until);
  graceEndsAt.setDate(graceEndsAt.getDate() + PAYMENT_GRACE_DAYS);
  return graceEndsAt;
}

// Only an order still waiting on its outcome may be granted. The check that
// it was pending ran before Toss was called; by the time the grant's lock is
// held, another path may have settled it — failed, expired or refunded — and
// that state must not be overwritten with a fresh period.
export class UngrantableChargeError extends Error {
  constructor(
    public readonly paymentId: string,
    public readonly status: string,
  ) {
    super(`Payment ${paymentId} is ${status}, not pending`);
    this.name = "UngrantableChargeError";
  }
}

function assertGrantable(paymentId: string, status: string) {
  if (status !== "pending") {
    throw new UngrantableChargeError(paymentId, status);
  }
}

// Toss approved a charge whose order the ledger had already settled another
// way: money taken with no period granted, and — since expired and failed
// rows are never looked at again — nothing that will fix it. Logged on its own
// so it stands out of the routine unresolved charges; a person refunds it in
// the Toss dashboard or grants the period. Recorded after the grant's
// transaction has rolled back, so never inside it.
async function noteOrphanedCharge(
  error: unknown,
  opts: { userId: string; subscriptionId?: string; payment: TossPaymentResult },
) {
  if (!(error instanceof UngrantableChargeError)) return;
  if (opts.payment.status !== "DONE") return;
  console.error(
    `[payments] ORPHANED charge: order ${opts.payment.orderId} was approved at Toss but payment ${error.paymentId} is ${error.status}`,
  );
  await notePaymentEvent({
    kind: "charge_orphaned",
    userId: opts.userId,
    paymentId: error.paymentId,
    subscriptionId: opts.subscriptionId ?? null,
    summary: `Toss에서 승인된 결제 ${won(opts.payment.totalAmount)} (주문 ${opts.payment.orderId}, paymentKey ${opts.payment.paymentKey})가 이미 ${error.status} 상태라 기간을 부여하지 못함 — Toss 대시보드에서 환불하거나 기간을 직접 부여해야 함`,
  });
}

// When the money moved: Toss's approval time. Usually a moment ago, but an
// orphaned charge recovered weeks later must not get a fresh refund window or
// count as paid after plans it predates.
function approvedAt(payment: TossPaymentResult, fallback: Date): Date {
  const at = payment.approvedAt ? new Date(payment.approvedAt) : null;
  return at && !Number.isNaN(at.getTime()) && at <= fallback ? at : fallback;
}

async function grantOrNote<T>(
  opts: { userId: string; subscriptionId?: string; payment: TossPaymentResult },
  grant: () => Promise<T>,
): Promise<T> {
  try {
    return await grant();
  } catch (error) {
    await noteOrphanedCharge(error, opts);
    throw error;
  }
}

// Applies a one-time payment: records the ledger row and extends supporter_until,
// stacking on top of any remaining time rather than resetting. `granted` is
// false when the payment had already been applied, so the caller's thank-you
// goes out once.
//
// A one-time purchase is not offered while a plan is live (the prepare and
// confirm routes and the reconciler refuse to start one), so it does not end
// or switch plans. If one is approved all the same — a confirm whose answer
// was lost, granted once a plan had started — the plan's next charge waits
// for the paid time it bought, so the same days are never charged twice.
export async function applyOneTimePayment(opts: {
  userId: string;
  amount: number;
  years: number;
  payment: TossPaymentResult;
  paymentId?: string;
}): Promise<{ periodStart: Date; periodEnd: Date; granted: boolean }> {
  if (!isOneTimeYears(opts.years)) {
    throw new Error("Invalid one-time support years");
  }
  const now = new Date();
  const paidAt = approvedAt(opts.payment, now);
  const period = await grantOrNote(opts, () =>
    db.transaction().execute(async (trx) => {
      if (opts.paymentId) {
        const ledger = await trx
          .selectFrom("payments")
          .select(["status", "period_start", "period_end"])
          .where("id", "=", opts.paymentId)
          .forUpdate()
          .executeTakeFirstOrThrow();
        if (
          ledger.status === "done" &&
          ledger.period_start &&
          ledger.period_end
        ) {
          return {
            periodStart: new Date(ledger.period_start),
            periodEnd: new Date(ledger.period_end),
            granted: false,
            notice: null,
          };
        }
        assertGrantable(opts.paymentId, ledger.status);
      }

      // Serialize entitlement extensions for this user. Two distinct donations
      // confirmed together must each add their full period.
      const paidUntil = await lockPaidTime(trx, opts.userId);
      const periodStart = paidUntil && paidUntil > now ? paidUntil : now;
      const periodEnd = addMonths(periodStart, 12 * opts.years);

      let paymentId = opts.paymentId;
      if (paymentId) {
        await trx
          .updateTable("payments")
          .set({
            ...paymentProviderMetadata(opts.payment, "one-time"),
            toss_payment_key: opts.payment.paymentKey,
            order_id: opts.payment.orderId,
            amount: opts.amount,
            status: "done",
            paid_at: paidAt,
            period_start: periodStart,
            period_end: periodEnd,
            raw: JSON.stringify(opts.payment),
          })
          .where("id", "=", paymentId)
          .execute();
      } else {
        const inserted = await trx
          .insertInto("payments")
          .values({
            ...paymentProviderMetadata(opts.payment, "one-time"),
            user_id: opts.userId,
            subscription_id: null,
            toss_payment_key: opts.payment.paymentKey,
            order_id: opts.payment.orderId,
            amount: opts.amount,
            status: "done",
            paid_at: paidAt,
            period_start: periodStart,
            period_end: periodEnd,
            raw: JSON.stringify(opts.payment),
          })
          .returning("id")
          .executeTakeFirstOrThrow();
        paymentId = inserted.id;
      }
      await recordApproval(trx, { paymentId, amount: opts.amount, at: paidAt });
      await extendPaidTime(trx, opts.userId, periodEnd);

      const deferred = await trx
        .updateTable("subscriptions")
        .set({
          current_period_end: periodEnd,
          next_billing_at: periodEnd,
          updated_at: now,
        })
        .where("user_id", "=", opts.userId)
        .where("status", "in", ["active", "scheduled"])
        .where("next_billing_at", "<", periodEnd)
        .returning("id")
        .executeTakeFirst();
      await recordPaymentEvent(trx, {
        kind: "charge_succeeded",
        userId: opts.userId,
        paymentId: opts.paymentId,
        subscriptionId: deferred?.id,
        summary: `한 번만 결제 ${won(opts.amount)} (${opts.years}년) · ${kstDate(periodEnd)}까지${deferred ? " · 진행 중인 정기 결제의 다음 결제를 그 뒤로 미룸" : ""}`,
      });
      // The thank-you owed for it, in this transaction (lib/payments/payment-jobs):
      // sent once, and only if the grant commits.
      const notice = opts.paymentId
        ? await enqueueJob(
            trx,
            { kind: "thank_you", paymentId: opts.paymentId },
            { dedupeKey: `thank_you:${opts.paymentId}` },
          )
        : null;
      return { periodStart, periodEnd, granted: true, notice };
    }),
  );
  const { notice, ...result } = period;
  await runJobs([notice]);
  return result;
}

// Applies a successful Toss charge atomically: records the payment, extends the
// subscription period, and mirrors the paid-through date onto users.supporter_until
// (the column the proxy and entitlement layer gate on). Used by both the initial
// confirm flow and the recurring-charge cron. `granted` is false when the
// payment had already been applied, so the caller's receipt goes out once.
//
// The new period never starts before the user's current supporter_until, as a
// one-time purchase may have stacked prepaid time past current_period_end, and
// overwriting supporter_until with an earlier date would take that time away.
// A subscription that was stopped while this charge was in flight stays
// stopped — the charge is recorded and its period granted, but it does not
// revive auto-renewal.
export async function applySuccessfulCharge(opts: {
  subscriptionId: string;
  userId: string;
  interval: BillingInterval;
  amount: number;
  from: Date; // base for the new period (now for first charge, current_period_end for renewals)
  payment: TossPaymentResult;
  paymentId?: string;
  // The mail owed when this grants: a thank-you for a signup's first charge,
  // a receipt for any later one.
  notice: "thank_you" | "receipt";
}): Promise<{ periodStart: Date; periodEnd: Date; granted: boolean }> {
  const now = new Date();
  const paidAt = approvedAt(opts.payment, now);

  const { notice, ...result } = await grantOrNote(opts, () =>
    db.transaction().execute(async (trx) => {
      if (opts.paymentId) {
        const ledger = await trx
          .selectFrom("payments")
          .select(["status", "period_start", "period_end"])
          .where("id", "=", opts.paymentId)
          .forUpdate()
          .executeTakeFirstOrThrow();
        if (
          ledger.status === "done" &&
          ledger.period_start &&
          ledger.period_end
        ) {
          return {
            periodStart: new Date(ledger.period_start),
            periodEnd: new Date(ledger.period_end),
            granted: false,
            notice: null,
          };
        }
        assertGrantable(opts.paymentId, ledger.status);
      }

      // Same lock order as applyOneTimePayment: payments, users, subscriptions.
      const paidUntil = await lockPaidTime(trx, opts.userId);
      const subscription = await trx
        .selectFrom("subscriptions")
        .select(["status", "billing_key_id"])
        .where("id", "=", opts.subscriptionId)
        .forUpdate()
        .executeTakeFirstOrThrow();

      const periodStart =
        paidUntil && paidUntil > opts.from ? paidUntil : opts.from;
      const periodEnd = addInterval(periodStart, opts.interval);

      let paymentId = opts.paymentId;
      if (paymentId) {
        await trx
          .updateTable("payments")
          .set({
            ...paymentProviderMetadata(opts.payment, "billing"),
            toss_payment_key: opts.payment.paymentKey,
            order_id: opts.payment.orderId,
            amount: opts.amount,
            status: "done",
            paid_at: paidAt,
            period_start: periodStart,
            period_end: periodEnd,
            raw: JSON.stringify(opts.payment),
          })
          .where("id", "=", paymentId)
          .execute();
      } else {
        const inserted = await trx
          .insertInto("payments")
          .values({
            ...paymentProviderMetadata(opts.payment, "billing"),
            user_id: opts.userId,
            subscription_id: opts.subscriptionId,
            toss_payment_key: opts.payment.paymentKey,
            order_id: opts.payment.orderId,
            amount: opts.amount,
            status: "done",
            paid_at: paidAt,
            period_start: periodStart,
            period_end: periodEnd,
            raw: JSON.stringify(opts.payment),
          })
          .returning("id")
          .executeTakeFirstOrThrow();
        paymentId = inserted.id;
      }
      await recordApproval(trx, { paymentId, amount: opts.amount, at: paidAt });

      // Without a billing key there is nothing to renew with: a signup whose
      // first charge was declined, then approved after all, has given its key
      // up. It gets its period, but is not marked active with nothing to
      // charge.
      const stopped = STOPPED_SUBSCRIPTION_STATUSES.includes(
        subscription.status,
      );
      const renewable = !stopped && subscription.billing_key_id != null;
      await trx
        .updateTable("subscriptions")
        .set({
          status: renewable ? "active" : subscription.status,
          current_period_start: periodStart,
          current_period_end: periodEnd,
          next_billing_at: renewable ? periodEnd : null,
          failed_charge_count: 0,
          renewal_notice_sent_at: null,
          payment_grace_notice_sent_at: null,
          updated_at: now,
        })
        .where("id", "=", opts.subscriptionId)
        .execute();
      await extendPaidTime(trx, opts.userId, periodEnd);
      await recordPaymentEvent(trx, {
        kind: "charge_succeeded",
        userId: opts.userId,
        paymentId: opts.paymentId,
        subscriptionId: opts.subscriptionId,
        summary: `정기 결제 ${won(opts.amount)} (${opts.interval === "month" ? "월간" : "연간"}) · ${kstDate(periodEnd)}까지${
          stopped
            ? ` · 구독은 ${subscription.status} 그대로`
            : renewable
              ? ""
              : " · 빌링키가 없어 자동 갱신은 하지 않음"
        }`,
      });
      const notice = opts.paymentId
        ? await enqueueJob(
            trx,
            opts.notice === "thank_you"
              ? { kind: "thank_you", paymentId: opts.paymentId }
              : { kind: "charge_receipt", paymentId: opts.paymentId },
            { dedupeKey: `${opts.notice}:${opts.paymentId}` },
          )
        : null;
      return { periodStart, periodEnd, granted: true, notice };
    }),
  );
  await runJobs([notice]);
  return result;
}

// Defers the first recurring charge to the end of prepaid access. Notice
// markers are reset because they may be left over from an earlier, canceled
// subscription; the renewal notice cron would otherwise skip the reminder
// owed before this first charge.
// Returns false when the subscription stopped waiting for its first charge
// (the supporter canceled it) before the schedule could be written.
export async function scheduleSubscriptionStart(
  subscriptionId: string,
  startsAt: Date,
  now = new Date(),
): Promise<boolean> {
  const result = await db
    .updateTable("subscriptions")
    .set({
      status: "scheduled",
      current_period_start: null,
      current_period_end: startsAt,
      next_billing_at: startsAt,
      failed_charge_count: 0,
      canceled_at: null,
      renewal_notice_sent_at: null,
      payment_grace_notice_sent_at: null,
      updated_at: now,
    })
    .where("id", "=", subscriptionId)
    .where("status", "in", ["incomplete", "scheduled"])
    .executeTakeFirst();
  return Number(result.numUpdatedRows ?? 0) > 0;
}

// A plan still incomplete holds a key only for the signup under way. Once
// that signup's first charge has failed for good, the key has nothing left to
// charge and is retired, rather than kept until the supporter happens to start
// over. The plan stays incomplete, keyless: its registration is spent — a
// reopened callback finds it so and asks to start over — and the next signup
// ends it. Callers hold the account lock, so no confirm of that signup is
// running meanwhile.
export async function retireUnusedSignupKey(
  trx: Executor,
  subscriptionId: string,
): Promise<string | null> {
  const row = await trx
    .selectFrom("subscriptions")
    .select("status")
    .where("id", "=", subscriptionId)
    .forUpdate()
    .executeTakeFirst();
  if (!row || row.status !== "incomplete") return null;
  return retireBillingKey(trx, { subscriptionId });
}
