import { randomUUID } from "crypto";
import { db } from "@/lib/database";
import { deleteRetiredBillingKey, retireBillingKey } from "@/lib/billing-keys";
import type { Executor } from "@/lib/entitlements";
import {
  kstDate,
  notePaymentEvent,
  recordPaymentEvent,
  won,
} from "@/lib/payment-events";
import {
  addInterval,
  addMonths,
  BillingInterval,
  isOneTimeYears,
  paymentProviderMetadata,
  TossPaymentResult,
} from "@/lib/toss";

// A renewal is tried at most once a day. This value is the payment grace window
// before a subscription becomes past_due and related paid-only resources are
// reclaimed.
export const PAYMENT_GRACE_DAYS = 4;
export const MAX_PAYMENT_RETRY_ATTEMPTS = 4;

// Subscriptions that must not be revived by a charge that was already in flight
// when the user (or a refund, or a one-time purchase) stopped them.
const STOPPED_SUBSCRIPTION_STATUSES = ["canceled", "switched_to_one_time"];

// Recurring billing that a one-time purchase replaces. Anything that still
// holds a billing key and could charge again belongs here — a signup still
// waiting on its first charge (incomplete) too, or a late success there would
// start auto-renewal after the supporter chose to pay once.
const SWITCHABLE_SUBSCRIPTION_STATUSES = [
  "incomplete",
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
// stacking on top of any remaining time rather than resetting. If recurring
// billing exists, the same transaction disables it so only prepaid access
// remains. `granted` is false when the payment had already been applied, so
// the caller's thank-you goes out once.
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
  const { retiredKey, ...period } = await grantOrNote(opts, () =>
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
            retiredKey: null,
          };
        }
        assertGrantable(opts.paymentId, ledger.status);
      }

      // Serialize entitlement extensions for this user. Two distinct donations
      // confirmed together must each add their full period.
      const current = await trx
        .selectFrom("users")
        .select("supporter_until")
        .where("id", "=", opts.userId)
        .forNoKeyUpdate()
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
            paid_at: paidAt,
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
            paid_at: paidAt,
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
      // boundary that now belongs to the prepaid period. Only a plan that
      // existed when the payment was approved: an old one-time order granted
      // late (recoverOrphanedCharge) must not end a plan started since.
      const switched = await trx
        .updateTable("subscriptions")
        .set({
          status: "switched_to_one_time",
          next_billing_at: null,
          canceled_at: now,
          updated_at: now,
        })
        .where("user_id", "=", opts.userId)
        .where("status", "in", SWITCHABLE_SUBSCRIPTION_STATUSES)
        .where("plan_started_at", "<=", paidAt)
        .returning("id")
        .executeTakeFirst();
      const retiredKey = switched
        ? await retireBillingKey(trx, { subscriptionId: switched.id })
        : null;
      await recordPaymentEvent(trx, {
        kind: "charge_succeeded",
        userId: opts.userId,
        paymentId: opts.paymentId,
        subscriptionId: switched?.id,
        summary: `한 번만 결제 ${won(opts.amount)} (${opts.years}년) · ${kstDate(periodEnd)}까지${switched ? " · 정기 결제는 한 번만 결제로 전환" : ""}`,
      });
      return { periodStart, periodEnd, granted: true, retiredKey };
    }),
  );
  await deleteRetiredBillingKey(retiredKey);
  return period;
}

// Applies a successful Toss charge atomically: records the payment, extends the
// subscription period, and mirrors the paid-through date onto users.supporter_until
// (the column the proxy and entitlement layer gate on). Used by both the initial
// confirm flow and the recurring-charge cron. `granted` is false when the
// payment had already been applied, so the caller's receipt goes out once.
//
// The new period never starts before the user's current supporter_until: a
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
}): Promise<{ periodStart: Date; periodEnd: Date; granted: boolean }> {
  const now = new Date();
  const paidAt = approvedAt(opts.payment, now);

  return grantOrNote(opts, () =>
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
          };
        }
        assertGrantable(opts.paymentId, ledger.status);
      }

      // Same lock order as applyOneTimePayment: payments, users, subscriptions.
      // FOR NO KEY UPDATE on the user serializes grants without blocking the
      // key-share lock a payment_events insert takes on it, which a transaction
      // holding the subscription may need.
      const current = await trx
        .selectFrom("users")
        .select("supporter_until")
        .where("id", "=", opts.userId)
        .forNoKeyUpdate()
        .executeTakeFirstOrThrow();
      const subscription = await trx
        .selectFrom("subscriptions")
        .select(["status", "toss_billing_key"])
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
            paid_at: paidAt,
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
            paid_at: paidAt,
            period_start: periodStart,
            period_end: periodEnd,
            raw: JSON.stringify(opts.payment),
          })
          .execute();
      }

      // Without a billing key there is nothing to renew with: a late renewal
      // reconciled after the supporter began registering a new card lands on
      // an incomplete subscription whose old key is gone. Marking that active
      // would make the new card's confirm report "already subscribed" and never
      // store the new key, so the status is left for the confirm to settle.
      const stopped = STOPPED_SUBSCRIPTION_STATUSES.includes(
        subscription.status,
      );
      const renewable = !stopped && subscription.toss_billing_key != null;
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
      await trx
        .updateTable("users")
        .set({ supporter_until: periodEnd })
        .where("id", "=", opts.userId)
        .execute();
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
      return { periodStart, periodEnd, granted: true };
    }),
  );
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

// A subscription still incomplete holds a key only for the signup under way.
// Once that signup's first charge has failed for good, the key has nothing
// left to charge and is retired, rather than kept in plain text until the
// supporter happens to start over. Callers hold the account lock, so no
// confirm of that signup is running meanwhile.
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
  const retired = await retireBillingKey(trx, { subscriptionId });
  // The signup is over: its callback, reopened, would get the same key back
  // from Toss — the issue call's idempotency key comes from the authKey and
  // replays for 15 days — and store and charge a card just retired. A new
  // registration id makes that callback stale; the supporter starts over with
  // a fresh prepare, as a failed first charge already asks them to.
  if (retired) {
    await trx
      .updateTable("subscriptions")
      .set({ card_registration_id: randomUUID() })
      .where("id", "=", subscriptionId)
      .execute();
  }
  return retired;
}
