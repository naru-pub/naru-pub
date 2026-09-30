import { db } from "@/lib/database";
import { deleteRetiredBillingKey, retireBillingKey } from "@/lib/billing-keys";
import {
  addInterval,
  addMonths,
  BillingInterval,
  isOneTimeYears,
  paymentProviderMetadata,
  TossPaymentResult,
} from "@/lib/toss";

// Subscription renewals run daily. This value is the payment grace window before
// a subscription becomes past_due and related paid-only resources are reclaimed.
export const PAYMENT_GRACE_DAYS = 4;
export const MAX_PAYMENT_RETRY_ATTEMPTS = 4;

// A charge in flight holds charging_started_at on its subscription. The renewal
// cron and the subscribe confirm share this lease, so two of them never charge
// the same subscription at once; a lease older than this is presumed dead.
export const CHARGE_LEASE_MINUTES = 30;

// Subscriptions that must not be revived by a charge that was already in flight
// when the user (or a refund, or a one-time purchase) stopped them.
const STOPPED_SUBSCRIPTION_STATUSES = ["canceled", "switched_to_one_time"];

// Recurring billing that a one-time purchase replaces. Anything that still
// holds a billing key and could charge again belongs here.
const SWITCHABLE_SUBSCRIPTION_STATUSES = [
  "active",
  "canceled",
  "scheduled",
  "past_due",
];

export function addPaymentGrace(until: Date): Date {
  const graceEndsAt = new Date(until);
  graceEndsAt.setDate(graceEndsAt.getDate() + PAYMENT_GRACE_DAYS);
  return graceEndsAt;
}

// Applies a one-time payment: records the ledger row and extends supporter_until,
// stacking on top of any remaining time rather than resetting. If recurring
// billing exists, the same transaction disables it so only prepaid access
// remains.
export async function applyOneTimePayment(opts: {
  userId: number;
  amount: number;
  years: number;
  payment: TossPaymentResult;
  paymentId?: number;
}): Promise<{ periodStart: Date; periodEnd: Date }> {
  if (!isOneTimeYears(opts.years)) {
    throw new Error("Invalid one-time support years");
  }
  const now = new Date();
  const { retiredKey, ...period } = await db
    .transaction()
    .execute(async (trx) => {
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
            retiredKey: null,
          };
        }
      }

      // Serialize entitlement extensions for this user. Two distinct donations
      // confirmed together must each add their full period.
      const current = await trx
        .selectFrom("users")
        .select("supporter_until")
        .where("id", "=", opts.userId)
        .forUpdate()
        .executeTakeFirstOrThrow();
      const periodStart =
        current.supporter_until && new Date(current.supporter_until) > now
          ? new Date(current.supporter_until)
          : now;
      const periodEnd = addMonths(periodStart, 12 * opts.years);

      if (opts.paymentId) {
        await trx
          .updateTable("payments")
          .set({
            ...paymentProviderMetadata(opts.payment, "one-time"),
            toss_payment_key: opts.payment.paymentKey,
            order_id: opts.payment.orderId,
            amount: opts.amount,
            status: "done",
            paid_at: now,
            period_start: periodStart,
            period_end: periodEnd,
            raw: JSON.stringify(opts.payment),
          })
          .where("id", "=", opts.paymentId)
          .execute();
      } else {
        await trx
          .insertInto("payments")
          .values({
            ...paymentProviderMetadata(opts.payment, "one-time"),
            user_id: opts.userId,
            subscription_id: null,
            toss_payment_key: opts.payment.paymentKey,
            order_id: opts.payment.orderId,
            amount: opts.amount,
            status: "done",
            paid_at: now,
            period_start: periodStart,
            period_end: periodEnd,
            raw: JSON.stringify(opts.payment),
          })
          .execute();
      }

      await trx
        .updateTable("users")
        .set({ supporter_until: periodEnd })
        .where("id", "=", opts.userId)
        .execute();

      // A confirmed one-time purchase switches an active recurring supporter to
      // prepaid access atomically, so the old billing key can never renew at the
      // boundary that now belongs to the prepaid period.
      const switched = await trx
        .updateTable("subscriptions")
        .set({
          status: "switched_to_one_time",
          next_billing_at: null,
          canceled_at: now,
          charging_started_at: null,
          updated_at: now,
        })
        .where("user_id", "=", opts.userId)
        .where("status", "in", SWITCHABLE_SUBSCRIPTION_STATUSES)
        .returning("id")
        .executeTakeFirst();
      const retiredKey = switched
        ? await retireBillingKey(trx, { subscriptionId: switched.id })
        : null;
      return { periodStart, periodEnd, retiredKey };
    });
  await deleteRetiredBillingKey(retiredKey);
  return period;
}

// Applies a successful Toss charge atomically: records the payment, extends the
// subscription period, and mirrors the paid-through date onto users.supporter_until
// (the column the proxy and entitlement layer gate on). Used by both the initial
// confirm flow and the recurring-charge cron.
//
// The new period never starts before the user's current supporter_until: a
// one-time purchase may have stacked prepaid time past current_period_end, and
// overwriting supporter_until with an earlier date would take that time away.
// A subscription that was stopped while this charge was in flight stays
// stopped — the charge is recorded and its period granted, but it does not
// revive auto-renewal.
export async function applySuccessfulCharge(opts: {
  subscriptionId: number;
  userId: number;
  interval: BillingInterval;
  amount: number;
  from: Date; // base for the new period (now for first charge, current_period_end for renewals)
  payment: TossPaymentResult;
  paymentId?: number;
}): Promise<{ periodStart: Date; periodEnd: Date }> {
  const now = new Date();

  return db.transaction().execute(async (trx) => {
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
        };
      }
    }

    // Same lock order as applyOneTimePayment: payments, users, subscriptions.
    const current = await trx
      .selectFrom("users")
      .select("supporter_until")
      .where("id", "=", opts.userId)
      .forUpdate()
      .executeTakeFirstOrThrow();
    const subscription = await trx
      .selectFrom("subscriptions")
      .select("status")
      .where("id", "=", opts.subscriptionId)
      .forUpdate()
      .executeTakeFirstOrThrow();

    let periodStart = opts.from;
    if (
      current.supporter_until &&
      new Date(current.supporter_until) > periodStart
    ) {
      periodStart = new Date(current.supporter_until);
    }
    const periodEnd = addInterval(periodStart, opts.interval);

    if (opts.paymentId) {
      await trx
        .updateTable("payments")
        .set({
          ...paymentProviderMetadata(opts.payment, "billing"),
          toss_payment_key: opts.payment.paymentKey,
          order_id: opts.payment.orderId,
          amount: opts.amount,
          status: "done",
          paid_at: now,
          period_start: periodStart,
          period_end: periodEnd,
          raw: JSON.stringify(opts.payment),
        })
        .where("id", "=", opts.paymentId)
        .execute();
    } else {
      await trx
        .insertInto("payments")
        .values({
          ...paymentProviderMetadata(opts.payment, "billing"),
          user_id: opts.userId,
          subscription_id: opts.subscriptionId,
          toss_payment_key: opts.payment.paymentKey,
          order_id: opts.payment.orderId,
          amount: opts.amount,
          status: "done",
          paid_at: now,
          period_start: periodStart,
          period_end: periodEnd,
          raw: JSON.stringify(opts.payment),
        })
        .execute();
    }

    const stopped = STOPPED_SUBSCRIPTION_STATUSES.includes(subscription.status);
    await trx
      .updateTable("subscriptions")
      .set({
        status: stopped ? subscription.status : "active",
        current_period_start: periodStart,
        current_period_end: periodEnd,
        next_billing_at: stopped ? null : periodEnd,
        failed_charge_count: 0,
        charging_started_at: null,
        renewal_notice_sent_at: null,
        payment_grace_notice_sent_at: null,
        updated_at: now,
      })
      .where("id", "=", opts.subscriptionId)
      .execute();

    await trx
      .updateTable("users")
      .set({ supporter_until: periodEnd })
      .where("id", "=", opts.userId)
      .execute();
    return { periodStart, periodEnd };
  });
}

// Takes the charge lease on a subscription, or returns null when another
// charge holds a live lease or the subscription is already active. The
// subscribe confirm uses this so a doubled callback cannot charge the first
// period twice.
export async function claimSubscriptionForConfirm(
  subscriptionId: number,
  now = new Date(),
): Promise<Date | null> {
  const staleLeaseBefore = new Date(
    now.getTime() - CHARGE_LEASE_MINUTES * 60 * 1000,
  );
  const claimed = await db
    .updateTable("subscriptions")
    .set({ charging_started_at: now, updated_at: now })
    .where("id", "=", subscriptionId)
    .where("status", "!=", "active")
    .where((eb) =>
      eb.or([
        eb("charging_started_at", "is", null),
        eb("charging_started_at", "<", staleLeaseBefore),
      ]),
    )
    .executeTakeFirst();
  return Number(claimed.numUpdatedRows ?? 0) > 0 ? now : null;
}

// Releases a lease taken at `leasedAt`. A lease that has since been cleared or
// re-taken by someone else is left alone.
export async function releaseSubscriptionLease(
  subscriptionId: number,
  leasedAt: Date,
): Promise<void> {
  await db
    .updateTable("subscriptions")
    .set({ charging_started_at: null })
    .where("id", "=", subscriptionId)
    .where("charging_started_at", "=", leasedAt)
    .execute();
}

// Defers the first recurring charge to the end of prepaid access. Notice
// markers are reset because they may be left over from an earlier, canceled
// subscription; the renewal notice cron would otherwise skip the reminder
// owed before this first charge.
export async function scheduleSubscriptionStart(
  subscriptionId: number,
  startsAt: Date,
  now = new Date(),
): Promise<void> {
  await db
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
    .execute();
}
