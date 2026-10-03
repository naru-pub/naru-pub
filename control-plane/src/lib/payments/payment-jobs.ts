import { Absurd } from "absurd-sdk";
import { sql } from "kysely";
import { AccountBusyError } from "@/lib/payments/account-lock";
import {
  sendPaymentCanceledNotice,
  sendSubscriptionCanceledNotice,
} from "@/lib/payments/cancellation-notices";
import { sendChargeReceipt } from "@/lib/payments/charge-receipts";
import { db, pool } from "@/lib/database";
import {
  sendSubscriptionPastDueEmail,
  sendSubscriptionPaymentGraceEmail,
  sendSupportThankYouEmail,
  type SubscriptionCancelReason,
  type SubscriptionPastDueReason,
} from "@/lib/email";
import type { Executor } from "@/lib/entitlements";
// Keeps each mail sent from here in payment_mails.
import { mailRecipient } from "@/lib/payments/payment-mails";

// Absurd owns claims, checkpoints, retry policy and durable sleeps. Domain
// changes and task creation commit together through absurd.spawn_task on the
// caller's Kysely executor. The ledger remains the source of truth.
// payment-job-v1 is versioned: preserve its handler until its tasks drain.

export type PaymentJob =
  // A thank-you for the purchase that started a support: a signup's first
  // charge or a one-time payment.
  | { kind: "thank_you"; paymentId: string }
  // A receipt for a later recurring charge.
  | { kind: "charge_receipt"; paymentId: string }
  | {
      kind: "payment_canceled";
      paymentId: string;
      subscriptionCanceled: boolean;
    }
  | {
      kind: "subscription_canceled";
      subscriptionId: string;
      reason: SubscriptionCancelReason;
    }
  // A renewal was declined; access lasts through the grace period.
  | { kind: "grace_notice"; subscriptionId: string }
  | {
      kind: "past_due_notice";
      subscriptionId: string;
      reason: SubscriptionPastDueReason;
      declinedAttempts?: number;
    }
  // A webhook's reconciliation, retried until Toss can be asked.
  | { kind: "reconcile_payment"; paymentId: string }
  // An accepted refund survives a crash before/after the external cancel.
  | { kind: "refund_payment"; paymentId: string; reason: string }
  // A plan's renewal for the day (lib/payments/subscription-renewals).
  | { kind: "renew_subscription"; subscriptionId: string };

export const MAX_ATTEMPTS = 8;
export const PAYMENT_QUEUE = "payments";
export const PAYMENT_TASK = "payment-job-v1";
// A money operation can make several 90-second Toss calls. Claim one task at
// a time so waiting in a claimed batch does not consume another task's lease.
const CLAIM_SECONDS = 600;
type Workflow = { job: PaymentJob; runAt?: string };
const workflows = new Absurd({ db: pool, queueName: PAYMENT_QUEUE });
workflows.registerTask<Workflow>(
  { name: PAYMENT_TASK },
  async (params, ctx) => {
    if (params.runAt) await ctx.sleepUntil("scheduled", new Date(params.runAt));
    while (true) {
      const busy = await ctx.step("perform", async () => {
        try {
          await handle(params.job);
          return false;
        } catch (error) {
          if (!(error instanceof AccountBusyError)) throw error;
          return true;
        }
      });
      if (!busy) return;
      // Checkpoint contention too, so replay skips earlier busy checks instead
      // of reacquiring the lock for every sleep the workflow already finished.
      await ctx.sleepFor("account-busy", 60);
    }
  },
);

// Use Absurd's SQL API on the supplied executor: a pool-based SDK spawn here
// would commit independently of the business change.
export async function enqueueJob(
  executor: Executor,
  job: PaymentJob,
  opts: { dedupeKey?: string; runAt?: Date } = {},
): Promise<string | null> {
  const params: Workflow = {
    job,
    ...(opts.runAt ? { runAt: opts.runAt.toISOString() } : {}),
  };
  const result = await sql<{ task_id: string; created: boolean }>`
    select task_id, created from absurd.spawn_task(
      ${PAYMENT_QUEUE}, ${PAYMENT_TASK}, ${JSON.stringify(params)}::jsonb,
      ${JSON.stringify({
        max_attempts: MAX_ATTEMPTS,
        idempotency_key: opts.dedupeKey,
        retry_strategy: {
          kind: "exponential",
          base_seconds: 60,
          factor: 2,
          max_seconds: 21600,
        },
      })}::jsonb)
  `.execute(executor);
  const row = result.rows[0];
  return row.created ? row.task_id : null;
}

export async function runDueJobs(
  limit = 50,
): Promise<{ done: number; retried: number; failed: number }> {
  const counts = { done: 0, retried: 0, failed: 0 };
  for (let i = 0; i < limit; i++) {
    const [task] = await workflows.claimTasks({
      workerId: `payments:${process.pid}`,
      claimTimeout: CLAIM_SECONDS,
      batchSize: 1,
    });
    if (!task) break;
    await workflows.executeTask(task, CLAIM_SECONDS);
    const result = await workflows.fetchTaskResult(task.task_id);
    if (result?.state === "completed") counts.done++;
    else if (result?.state === "failed") {
      counts.failed++;
    } else counts.retried++;
  }
  return counts;
}

async function handle(job: PaymentJob): Promise<void> {
  switch (job.kind) {
    case "refund_payment": {
      const { resumeRefund } = await import("@/lib/payments/refunds");
      await resumeRefund(job.paymentId, job.reason);
      return;
    }
    case "thank_you":
      return sendThankYou(job.paymentId);
    case "charge_receipt":
      return sendChargeReceipt(job.paymentId);
    case "payment_canceled":
      return sendPaymentCanceledNotice(job.paymentId, {
        subscriptionCanceled: job.subscriptionCanceled,
      });
    case "subscription_canceled":
      return sendSubscriptionCanceledNotice(job.subscriptionId, job.reason);
    case "grace_notice":
      return sendGraceNotice(job.subscriptionId);
    case "past_due_notice":
      return sendPastDueNotice(job);
    case "renew_subscription": {
      // Imported here: renewals enqueue jobs themselves.
      const { renewSubscription } =
        await import("@/lib/payments/subscription-renewals");
      return renewSubscription(job.subscriptionId);
    }
    case "reconcile_payment": {
      // Imported here: reconciliation enqueues jobs itself.
      const { reconcilePayment } =
        await import("@/lib/payments/payment-reconciliation");
      // A little wait for the account, as a webhook used to: the operation
      // holding it is usually one that just finished.
      await reconcilePayment(job.paymentId, {
        waitMs: 5000,
        deferKeyDeletion: true,
      });
      return;
    }
  }
}

async function sendThankYou(paymentId: string): Promise<void> {
  const row = await db
    .selectFrom("payments")
    .select(["user_id", "amount", "attempt_key", "period_end"])
    .where("id", "=", paymentId)
    .where("status", "=", "done")
    .executeTakeFirst();
  if (!row || !row.period_end) return;
  const to = await mailRecipient(row.user_id);
  if (!to) return;
  await sendSupportThankYouEmail({
    email: to.email,
    loginName: to.loginName,
    kind: row.attempt_key?.startsWith("one_time:") ? "one_time" : "recurring",
    amount: row.amount,
    supporterUntil: new Date(row.period_end),
    ref: { userId: row.user_id, paymentId },
  });
}

// Grace periods follow supporter_until (lib/entitlements); the notice says
// when this one ends, and is sent once per lapse.
async function sendGraceNotice(subscriptionId: string): Promise<void> {
  const { addPaymentGrace } = await import("@/lib/payments/subscriptions");
  const row = await db
    .selectFrom("subscriptions")
    .select([
      "user_id",
      "amount",
      "status",
      "current_period_end",
      "payment_grace_notice_sent_at",
    ])
    .where("id", "=", subscriptionId)
    .executeTakeFirst();
  if (!row || !row.current_period_end || row.payment_grace_notice_sent_at) {
    return;
  }
  // Past due too: the retries can run out before the grace period does.
  if (!["active", "scheduled", "past_due"].includes(row.status)) return;
  const graceEndsAt = addPaymentGrace(new Date(row.current_period_end));
  // A grace notice whose grace period has already ended would tell the user
  // they still have time they do not have.
  if (graceEndsAt <= new Date()) return;
  const to = await mailRecipient(row.user_id);
  if (!to) return;
  await sendSubscriptionPaymentGraceEmail({
    email: to.email,
    loginName: to.loginName,
    amount: row.amount,
    graceEndsAt,
    ref: { userId: row.user_id, subscriptionId },
  });
  await db
    .updateTable("subscriptions")
    .set({ payment_grace_notice_sent_at: new Date(), updated_at: new Date() })
    .where("id", "=", subscriptionId)
    .execute();
}

async function sendPastDueNotice(
  job: Extract<PaymentJob, { kind: "past_due_notice" }>,
): Promise<void> {
  const { getUserEntitlement } = await import("@/lib/entitlements");
  const row = await db
    .selectFrom("subscriptions")
    .select(["amount", "user_id"])
    .where("id", "=", job.subscriptionId)
    .executeTakeFirst();
  if (!row) return;
  const to = await mailRecipient(row.user_id);
  if (!to) return;
  // Paid features follow supporter_until and its grace window, which may
  // still be running when the retries are spent.
  const entitlement = await getUserEntitlement(row.user_id);
  await sendSubscriptionPastDueEmail({
    email: to.email,
    loginName: to.loginName,
    amount: row.amount,
    reason: job.reason,
    declinedAttempts: job.declinedAttempts,
    accessEndsAt: entitlement.comp
      ? undefined
      : entitlement.isSupporter
        ? entitlement.graceEndsAt
        : null,
    ref: { userId: row.user_id, subscriptionId: job.subscriptionId },
  });
}
