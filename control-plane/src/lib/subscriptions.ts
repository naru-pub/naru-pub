import { db } from "@/lib/database";
import {
  addInterval,
  BillingInterval,
  isOneTimeYears,
  TossPaymentResult,
} from "@/lib/toss";

// Subscription renewals run daily. This value is the payment grace window before
// a subscription becomes past_due and related paid-only resources are reclaimed.
export const PAYMENT_GRACE_DAYS = 4;
export const MAX_PAYMENT_RETRY_ATTEMPTS = 4;

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
    const periodEnd = new Date(periodStart);
    periodEnd.setFullYear(periodEnd.getFullYear() + opts.years);

    if (opts.paymentId) {
      await trx
        .updateTable("payments")
        .set({
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
    await trx
      .updateTable("subscriptions")
      .set({
        status: "switched_to_one_time",
        toss_billing_key: null,
        next_billing_at: null,
        canceled_at: now,
        charging_started_at: null,
        updated_at: now,
      })
      .where("user_id", "=", opts.userId)
      .where("status", "in", ["active", "canceled"])
      .execute();
    return { periodStart, periodEnd };
  });
}

// Applies a successful Toss charge atomically: records the payment, extends the
// subscription period, and mirrors the paid-through date onto users.supporter_until
// (the column the proxy and entitlement layer gate on). Used by both the initial
// confirm flow and the recurring-charge cron.
export async function applySuccessfulCharge(opts: {
  subscriptionId: number;
  userId: number;
  interval: BillingInterval;
  amount: number;
  from: Date; // base for the new period (now for first charge, current_period_end for renewals)
  preserveExistingEntitlement?: boolean;
  subscriptionStatus?: "active" | "canceled";
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

    let periodStart = opts.from;
    if (opts.preserveExistingEntitlement) {
      const current = await trx
        .selectFrom("users")
        .select("supporter_until")
        .where("id", "=", opts.userId)
        .forUpdate()
        .executeTakeFirstOrThrow();
      if (
        current.supporter_until &&
        new Date(current.supporter_until) > periodStart
      ) {
        periodStart = new Date(current.supporter_until);
      }
    }
    const periodEnd = addInterval(periodStart, opts.interval);

    if (opts.paymentId) {
      await trx
        .updateTable("payments")
        .set({
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

    const subscriptionStatus = opts.subscriptionStatus ?? "active";
    await trx
      .updateTable("subscriptions")
      .set({
        status: subscriptionStatus,
        current_period_start: periodStart,
        current_period_end: periodEnd,
        next_billing_at: subscriptionStatus === "active" ? periodEnd : null,
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
