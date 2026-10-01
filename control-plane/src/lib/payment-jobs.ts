import { sql } from "kysely";
import { AccountBusyError } from "@/lib/account-lock";
import {
  sendPaymentCanceledNotice,
  sendSubscriptionCanceledNotice,
} from "@/lib/cancellation-notices";
import { sendChargeReceipt } from "@/lib/charge-receipts";
import { db } from "@/lib/database";
import {
  sendSubscriptionPastDueEmail,
  sendSubscriptionPaymentGraceEmail,
  sendSupportThankYouEmail,
  type SubscriptionCancelReason,
  type SubscriptionPastDueReason,
} from "@/lib/email";
import type { Executor } from "@/lib/entitlements";
import { notePaymentEvent } from "@/lib/payment-events";
// Keeps each mail sent from here in payment_mails.
import "@/lib/payment-mails";

// Work the payment code owes after a change, kept in payment_jobs (see the
// migration that adds it): the mail a supporter is owed, a webhook's
// reconciliation. A job is enqueued in the same transaction as the change it
// follows, so it exists exactly when the change does — never a mail for a
// change that rolled back, never a change whose mail was lost when the process
// died after committing. The request runs its jobs right after committing
// (runJobs), so mail still goes out at once; the run-payment-jobs cron retries
// whatever failed, with backoff, and gives up with an operator event after
// MAX_ATTEMPTS.

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
  // A plan's renewal for the day (lib/subscription-renewals).
  | { kind: "renew_subscription"; subscriptionId: string };

export const MAX_ATTEMPTS = 8;
const LOCK_FOR = "5 minutes";

// Enqueues a job in the caller's transaction. Returns its id, or null when a
// job with the same dedupe key already exists (the thing is already owed).
export async function enqueueJob(
  executor: Executor,
  job: PaymentJob,
  opts: { dedupeKey?: string; runAt?: Date } = {},
): Promise<string | null> {
  const row = await executor
    .insertInto("payment_jobs")
    .values({
      kind: job.kind,
      payload: JSON.stringify(job),
      dedupe_key: opts.dedupeKey ?? null,
      // The database's now() unless given: the claim compares with it, and a
      // job run right after enqueueing must be due.
      ...(opts.runAt ? { run_at: opts.runAt } : {}),
    })
    .onConflict((oc) => oc.column("dedupe_key").doNothing())
    .returning("id")
    .executeTakeFirst();
  return row?.id ?? null;
}

// Runs the given jobs now, after the transaction that enqueued them has
// committed. Best effort: a job that fails stays queued for the cron.
export async function runJobs(ids: Array<string | null>): Promise<void> {
  for (const id of ids) {
    if (id) await runJob(id);
  }
}

// Runs every job that is due, oldest first, up to `limit`. The cron calls it
// every minute. Job times are all the database's clock.
export async function runDueJobs(
  limit = 50,
): Promise<{ done: number; retried: number; failed: number }> {
  const due = await db
    .selectFrom("payment_jobs")
    .select("id")
    .where("done_at", "is", null)
    .where("failed_at", "is", null)
    // The database's clock, as the claim uses: run_at has microseconds, and
    // a JavaScript Date would see a job enqueued this millisecond as not due.
    .where("run_at", "<=", sql<Date>`now()`)
    .where((eb) =>
      eb.or([
        eb("locked_until", "is", null),
        eb("locked_until", "<", sql<Date>`now()`),
      ]),
    )
    .orderBy("run_at")
    .limit(limit)
    .execute();
  const counts = { done: 0, retried: 0, failed: 0 };
  for (const { id } of due) counts[await runJob(id)] += 1;
  return counts;
}

type JobResult = "done" | "retried" | "failed";

async function runJob(id: string): Promise<JobResult> {
  // Claimed for a while, so a second runner skips it; a runner that dies
  // leaves the claim to lapse.
  const claimed = await sql<{
    id: string;
    payload: PaymentJob;
    attempts: number;
  }>`
    UPDATE payment_jobs
    SET locked_until = now() + ${sql.raw(`interval '${LOCK_FOR}'`)},
        attempts = attempts + 1
    WHERE id = ${id}
      AND done_at IS NULL AND failed_at IS NULL
      AND run_at <= now()
      AND (locked_until IS NULL OR locked_until < now())
    RETURNING id, payload, attempts
  `.execute(db);
  const job = claimed.rows[0];
  if (!job) return "retried";
  const payload =
    typeof job.payload === "string"
      ? (JSON.parse(job.payload) as PaymentJob)
      : job.payload;

  try {
    await handle(payload);
    await db
      .updateTable("payment_jobs")
      .set({ done_at: sql<Date>`now()`, locked_until: null, last_error: null })
      .where("id", "=", id)
      .execute();
    return "done";
  } catch (error) {
    const message = (
      error instanceof Error ? error.message : String(error)
    ).slice(0, 2000);
    // Another payment operation holds the account: not this job's failure.
    if (error instanceof AccountBusyError) {
      await db
        .updateTable("payment_jobs")
        .set({
          attempts: job.attempts - 1,
          locked_until: null,
          run_at: sql<Date>`now() + interval '1 minute'`,
        })
        .where("id", "=", id)
        .execute();
      return "retried";
    }
    if (job.attempts >= MAX_ATTEMPTS) {
      await db
        .updateTable("payment_jobs")
        .set({
          failed_at: sql<Date>`now()`,
          locked_until: null,
          last_error: message,
        })
        .where("id", "=", id)
        .execute();
      await notePaymentEvent({
        kind: "job_failed",
        summary: `결제 후속 작업 ${payload.kind}가 ${job.attempts}번 실패해 멈췄습니다: ${message.slice(0, 300)}`,
      });
      console.error(
        `[payment-jobs] job ${id} (${payload.kind}) gave up`,
        error,
      );
      return "failed";
    }
    // 1, 2, 4 … minutes, at most six hours.
    const backoffMinutes = Math.min(2 ** (job.attempts - 1), 360);
    await db
      .updateTable("payment_jobs")
      .set({
        locked_until: null,
        last_error: message,
        run_at: sql<Date>`now() + make_interval(mins => ${backoffMinutes})`,
      })
      .where("id", "=", id)
      .execute();
    console.error(`[payment-jobs] job ${id} (${payload.kind}) failed`, error);
    return "retried";
  }
}

async function handle(job: PaymentJob): Promise<void> {
  switch (job.kind) {
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
      const { renewSubscription } = await import("@/lib/subscription-renewals");
      return renewSubscription(job.subscriptionId);
    }
    case "reconcile_payment": {
      // Imported here: reconciliation enqueues jobs itself.
      const { reconcilePayment } = await import("@/lib/payment-reconciliation");
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
    .innerJoin("users", "users.id", "payments.user_id")
    .select([
      "payments.user_id",
      "payments.amount",
      "payments.attempt_key",
      "payments.period_end",
      "users.email",
      "users.email_verified_at",
      "users.login_name",
    ])
    .where("payments.id", "=", paymentId)
    .where("payments.status", "=", "done")
    .executeTakeFirst();
  if (!row || !row.email || !row.email_verified_at || !row.period_end) return;
  await sendSupportThankYouEmail({
    email: row.email,
    loginName: row.login_name,
    kind: row.attempt_key?.startsWith("one_time:") ? "one_time" : "recurring",
    amount: row.amount,
    supporterUntil: new Date(row.period_end),
    ref: { userId: row.user_id, paymentId },
  });
}

// Grace periods follow supporter_until (lib/entitlements); the notice says
// when this one ends, and is sent once per lapse.
async function sendGraceNotice(subscriptionId: string): Promise<void> {
  const { addPaymentGrace } = await import("@/lib/subscriptions");
  const row = await db
    .selectFrom("subscriptions")
    .innerJoin("users", "users.id", "subscriptions.user_id")
    .select([
      "subscriptions.user_id",
      "subscriptions.amount",
      "subscriptions.status",
      "subscriptions.current_period_end",
      "subscriptions.payment_grace_notice_sent_at",
      "users.email",
      "users.email_verified_at",
      "users.login_name",
    ])
    .where("subscriptions.id", "=", subscriptionId)
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
  if (!row.email || !row.email_verified_at) return;
  await sendSubscriptionPaymentGraceEmail({
    email: row.email,
    loginName: row.login_name,
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
    .innerJoin("users", "users.id", "subscriptions.user_id")
    .select([
      "subscriptions.amount",
      "subscriptions.user_id",
      "users.email",
      "users.email_verified_at",
      "users.login_name",
    ])
    .where("subscriptions.id", "=", job.subscriptionId)
    .executeTakeFirst();
  if (!row || !row.email || !row.email_verified_at) return;
  // Paid features follow supporter_until and its grace window, which may
  // still be running when the retries are spent.
  const entitlement = await getUserEntitlement(row.user_id);
  await sendSubscriptionPastDueEmail({
    email: row.email,
    loginName: row.login_name,
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
