import { sql } from "kysely";
import {
  ENDED_SUBSCRIPTION_STATUSES,
  type SubscriptionStatus,
} from "@/lib/payments/payment-states";
import type { SubscriptionCancelReason } from "@/lib/email";
import { enqueueJob } from "@/lib/payments/payment-jobs";
import { db } from "@/lib/database";
import { retireBillingKey } from "@/lib/payments/billing-keys";
import type { Executor } from "@/lib/entitlements";
import { recordPaymentEvent } from "@/lib/payments/payment-events";

// A renewal is tried at most once a day. This value is the payment grace window
// before a subscription becomes past_due and related paid-only resources are
// reclaimed.
export const PAYMENT_GRACE_DAYS = 4;
export const MAX_PAYMENT_RETRY_ATTEMPTS = 4;

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
  // The cancel mail task committed with this change.
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
  executor: Executor = db,
): Promise<boolean> {
  const result = await executor
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
