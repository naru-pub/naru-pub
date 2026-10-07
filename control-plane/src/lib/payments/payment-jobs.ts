import { uuidv7 } from "@/lib/uuid";
import { scheduledRecurringStart } from "@/lib/payments/support-purchases";
import { scheduleSubscriptionStart } from "@/lib/payments/subscriptions";
import { recordPaymentEvent } from "@/lib/payments/payment-events";
import { chargeableKey } from "@/lib/payments/billing-keys";
import {
  chargeOrder,
  confirmOrder,
  lookupOrder,
} from "@/lib/payments/toss-gateway";
import {
  describeTossError,
  oneTimeYearsForAmount,
  PLAN_ORDER_NAMES,
  type BillingInterval,
} from "@/lib/payments/toss";
import { notePaymentEvent, won } from "@/lib/payments/payment-events";
import { readRefundPayment, RefundError } from "@/lib/payments/refunds";
import {
  applyVerifiedTossPayment,
  TossPaymentMismatchError,
} from "@/lib/payments/payment-facts";
import { deleteRetiredBillingKey } from "@/lib/payments/billing-keys";
import {
  reconcilePayment,
  oneTimeOrderSuperseded,
  type ReconciliationResult,
} from "@/lib/payments/payment-reconciliation";
import { LIVE_SUBSCRIPTION_STATUSES } from "@/lib/payments/payment-states";
import { endPlan } from "@/lib/payments/subscriptions";
import { paymentFlowForRecord, paymentOfOtherMid } from "@/lib/payments/toss";
import { cancelOrder } from "@/lib/payments/toss-gateway";
import { isTossTestMode, withTossLab } from "@/lib/payments/toss";
import { Absurd } from "absurd-sdk";
import { sql } from "kysely";
import { AccountBusyError, withAccountLock } from "@/lib/payments/account-lock";
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
  | { kind: "enqueue_due_renewals" }
  | { kind: "repair_entitlement"; repairId: string; userId: string }
  | { kind: "confirm_one_time"; paymentId: string }
  | {
      kind: "initial_subscription_charge";
      paymentId: string;
      subscriptionId: string;
      billingKeyId: string;
    }
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
  | {
      kind: "refund_payment";
      paymentId: string;
      reason: string;
      testCode?: string;
    }
  // A plan's renewal for the day (lib/payments/subscription-renewals).
  | {
      kind: "renew_subscription";
      subscriptionId: string;
      cardRegistrationId?: string;
      lab?: boolean;
      testCode?: string;
    };

export const MAX_ATTEMPTS = 8;
export const PAYMENT_QUEUE = "payments";
export const PAYMENT_TASK = "payment-job-v1";
export const PAYMENT_RETRY_OPTIONS = {
  max_attempts: MAX_ATTEMPTS,
  retry_strategy: {
    kind: "exponential",
    base_seconds: 60,
    factor: 2,
    max_seconds: 21600,
  },
} as const;
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
        ...PAYMENT_RETRY_OPTIONS,
        idempotency_key: opts.dedupeKey,
      })}::jsonb)
  `.execute(executor);
  const row = result.rows[0];
  return row.created ? row.task_id : null;
}

// The SDK owns the polling loop, capacity, claims and draining. Start it in
// the existing background worker process; no minute cron or subprocess timeout.
export async function runPaymentWorker(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  const worker = await workflows.startWorker({
    workerId: `payments:${process.pid}`,
    claimTimeout: CLAIM_SECONDS,
    concurrency: 4,
    batchSize: 1,
    pollInterval: 0.5,
    onError: (error) => console.error("[payments-worker] error", error),
  });
  console.log("[payments-worker] Started (concurrency=4)");
  try {
    await new Promise<void>((resolve) => {
      if (signal.aborted) resolve();
      else signal.addEventListener("abort", () => resolve(), { once: true });
    });
  } finally {
    await worker.close();
    console.log("[payments-worker] Drained");
  }
}

// A bounded drain for integration tests. Production uses the SDK worker above.
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
    case "repair_entitlement": {
      const { runEntitlementRepair } =
        await import("@/lib/payments/entitlement-repair");
      await runEntitlementRepair(job.repairId);
      return;
    }
    case "enqueue_due_renewals": {
      const { noteJobStarted } = await import("@/lib/scheduled-jobs");
      const { enqueueDueRenewals } =
        await import("@/lib/payments/subscription-renewals");
      await noteJobStarted("subscription-charger");
      await enqueueDueRenewals();
      return;
    }
    case "confirm_one_time":
      return confirmOneTime(job.paymentId);
    case "initial_subscription_charge":
      return chargeInitialSubscription(job);
    case "refund_payment": {
      if (job.testCode && isTossTestMode()) {
        const outcome = await withTossLab({ testCode: job.testCode }, () =>
          resumeRefund(job.paymentId, job.reason),
        );
        if (outcome.error) throw outcome.error;
      } else await resumeRefund(job.paymentId, job.reason);
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
      const run = () =>
        renewSubscription(job.subscriptionId, new Date(), {
          cardRegistrationId: job.cardRegistrationId,
          lab: job.lab,
        });
      if (job.lab) {
        if (!isTossTestMode())
          throw new Error("Billing lab renewal requires Toss test mode");
        const outcome = await withTossLab({ testCode: job.testCode }, run);
        if (outcome.error) throw outcome.error;
      } else await run();
      return;
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

// Refunding ends the billing relationship, not just this one charge.
// Reconciliation stops the account's recurring plan when it first sees the
// refund; this is for a cancel Toss accepted but the lookup does not show yet.
async function stopRecurringBilling(
  userId: string,
  subscriptionId: string | null,
): Promise<boolean> {
  if (!subscriptionId) return false;
  const ended = await db.transaction().execute(async (trx) => {
    const live = await trx
      .selectFrom("subscriptions")
      .select("id")
      .where("user_id", "=", userId)
      .where("id", "=", subscriptionId)
      .where("status", "in", LIVE_SUBSCRIPTION_STATUSES)
      .executeTakeFirst();
    // The refund's own cancel mail went out before this stop, or goes out
    // later without it, so it cannot say so: this one does.
    return live
      ? endPlan(trx, live.id, {
          summary: () => "환불에 따라 정기 결제도 취소",
          notice: "refund",
        })
      : null;
  });
  if (!ended) return false;
  await deleteRetiredBillingKey(ended.retiredKey);

  return true;
}

// The policy was checked at acceptance. A worker restarting after the seven
// day window still owes that refund, including after account deletion.
async function resumeRefund(paymentId: string, reason: string): Promise<void> {
  const owner = await readRefundPayment(paymentId);
  if (!owner) return;
  return withAccountLock(owner.user_id, { waitMs: 0 }, async () => {
    const payment = await readRefundPayment(paymentId);
    if (!payment?.refund_requested_at) return;
    if (payment.refunded_amount > 0) {
      await stopRecurringBilling(
        payment.user_id,
        payment.refund_subscription_id,
      );
      return;
    }
    await finishRefund(payment, reason, payment.refund_subscription_id);
    const settled = await readRefundPayment(paymentId);
    if (settled && settled.refunded_amount === 0) {
      throw new RefundError("환불 결과를 확인하고 있습니다.", 503);
    }
  });
}

async function finishRefund(
  payment: NonNullable<Awaited<ReturnType<typeof readRefundPayment>>>,
  reason: string,
  planRunningBefore: string | null,
): Promise<void> {
  if (!payment.toss_payment_key)
    throw new RefundError("결제 승인 정보가 없습니다.", 409);
  const otherMid = paymentOfOtherMid(payment);
  if (otherMid) throw new RefundError(otherMid.message, 409);

  let refunded: ReconciliationResult | null = null;
  const canceled = await cancelOrder({
    flow: paymentFlowForRecord(payment.toss_flow, payment.attempt_key),
    paymentKey: payment.toss_payment_key,
    cancelReason: reason.slice(0, 200),
  });
  if (canceled.kind !== "canceled") {
    // Toss refuses to cancel a payment that is already canceled — with
    // ALREADY_CANCELED_PAYMENT or NOT_CANCELABLE_PAYMENT, and the latter also
    // covers other refusals — and a call that got no answer (a timeout, a
    // dropped connection) may have canceled it all the same. Ask Toss what the
    // payment is now: if the money is already back, only the ledger is behind
    // and reconciliation catches it up, and the refund goes on to stop
    // recurring billing like any other.
    const result = await reconcilePayment(payment.id).catch(() => null);
    if (result?.state !== "refunded") {
      // Toss answered and did not cancel: the supporter can try again. Not
      // when it said the payment is already canceled — the money is back,
      // and only the lookup to confirm it failed — or already being refunded
      // (ALREADY_REFUNDING_PAYMENT), which is a refund under way.
      if (
        canceled.kind === "refused" &&
        canceled.error.code !== "ALREADY_CANCELED_PAYMENT" &&
        canceled.error.code !== "ALREADY_REFUNDING_PAYMENT"
      ) {
        throw canceled.error;
      }
      // No answer either way. The webhook and the refund sweep will see the
      // cancel if it happened; until then the supporter is told so rather
      // than that it failed, which would invite a second request.
      throw new RefundError(
        "환불 결과를 확인하고 있습니다. 잠시 후 결제 내역을 다시 확인해 주세요.",
        503,
      );
    }
    refunded = result;
  }

  // Toss accepted the cancel, so the refund has happened whatever the
  // local transaction does: a failed commit is caught up by the durable task
  // or sweep, and must not tell the supporter that Toss refused the refund.
  if (canceled.kind === "canceled") {
    refunded = await applyVerifiedTossPayment(payment.id, canceled.payment)
      .then(async (result) => {
        await deleteRetiredBillingKey(result.retiredKey);
        return result;
      })
      .catch((error) => {
        if (error instanceof TossPaymentMismatchError) throw error;
        console.error(
          `Refund of payment ${payment.id}: Toss canceled it, but applying its response failed`,
          error,
        );
        return null;
      });
  }
  if (refunded?.state !== "refunded" || refunded.amount === 0) {
    await stopRecurringBilling(payment.user_id, planRunningBefore);
  }
}

// Only the claimed Absurd task can charge a newly registered subscription.
async function chargeInitialSubscription(
  job: Extract<PaymentJob, { kind: "initial_subscription_charge" }>,
): Promise<void> {
  const owner = await db
    .selectFrom("payments")
    .select("user_id")
    .where("id", "=", job.paymentId)
    .executeTakeFirstOrThrow();
  await withAccountLock(owner.user_id, { waitMs: 0 }, async () => {
    const attempt = await db
      .selectFrom("payments")
      .selectAll()
      .where("id", "=", job.paymentId)
      .executeTakeFirstOrThrow();
    if (attempt.status !== "pending") return;
    const sub = await db
      .selectFrom("subscriptions")
      .selectAll()
      .where("id", "=", job.subscriptionId)
      .executeTakeFirstOrThrow();
    if (
      attempt.subscription_id !== sub.id ||
      attempt.user_id !== sub.user_id ||
      attempt.amount !== sub.amount ||
      !attempt.attempt_key?.startsWith(`subscription_initial:${sub.id}:`)
    )
      throw new Error("Initial charge identity mismatch");
    if (
      sub.status !== "incomplete" ||
      sub.billing_key_id !== job.billingKeyId
    ) {
      if (attempt.charge_attempted_at) {
        const settled = await reconcilePayment(attempt.id);
        if (settled.state === "pending")
          throw new Error("Initial charge outcome is unknown");
      } else {
        await db.transaction().execute(async (trx) => {
          await trx
            .updateTable("payments")
            .set({ status: "expired" })
            .where("id", "=", attempt.id)
            .where("status", "=", "pending")
            .execute();
          await recordPaymentEvent(trx, {
            kind: "order_expired",
            userId: sub.user_id,
            paymentId: attempt.id,
            subscriptionId: sub.id,
            summary:
              "가입 상태나 카드가 바뀌어 보내지 않은 첫 결제 주문을 종료",
          });
        });
      }
      return;
    }
    // Paid time can change between acceptance and execution. An unsent order
    // must wait behind paid time acquired in the meantime.
    const account = await db
      .selectFrom("users")
      .select(["supporter_until", "login_name"])
      .where("id", "=", sub.user_id)
      .executeTakeFirstOrThrow();
    const startsAt = scheduledRecurringStart(
      account.supporter_until,
      new Date(),
    );
    if (!attempt.charge_attempted_at && startsAt) {
      await db.transaction().execute(async (trx) => {
        await scheduleSubscriptionStart(sub.id, startsAt, new Date(), trx);
        await trx
          .updateTable("payments")
          .set({ status: "expired" })
          .where("id", "=", attempt.id)
          .where("status", "=", "pending")
          .where("charge_attempted_at", "is", null)
          .execute();
        await recordPaymentEvent(trx, {
          kind: "subscription_scheduled",
          userId: sub.user_id,
          subscriptionId: sub.id,
          paymentId: attempt.id,
          summary: "첫 결제 대기 중 이용 기간이 생겨 정기 결제를 그 뒤로 예약",
        });
      });
      return;
    }
    const key = await chargeableKey(db, sub.id);
    if (!key) throw new Error("Initial charge billing key is unavailable");
    const userId = sub.user_id;
    const interval = sub.billing_interval as BillingInterval;
    const now = new Date();
    const outcome = await chargeOrder({
      billingKey: key.billingKey,
      customerKey: key.customerKey,
      amount: sub.amount,
      orderId: attempt.order_id,
      orderName: PLAN_ORDER_NAMES[interval],
      customerName: account.login_name,
      sentBefore: attempt.charge_attempted_at != null,
      beforeSend: async () => {
        await db
          .updateTable("payments")
          .set({ charge_attempted_at: new Date() })
          .where("id", "=", attempt.id)
          .execute();
      },
    });
    if (outcome.kind === "unknown") {
      // Keep the attempt pending, and the key with it, so the next callback or
      // the reconciler settles this orderId.
      await notePaymentEvent({
        kind: "charge_unresolved",
        userId,
        paymentId: attempt.id,
        subscriptionId: sub.id,
        summary: `정기 결제 첫 결제 ${won(sub.amount)} 결과 불분명 (주문 ${attempt.order_id}): ${
          outcome.tossStatus
            ? `Toss 상태 ${outcome.tossStatus}`
            : describeTossError(outcome.error)
        }`,
      });
      throw new Error("Initial subscription charge outcome is unknown");
    }
    if (outcome.kind === "declined") {
      if (outcome.payment) {
        const result = await applyVerifiedTossPayment(
          attempt.id,
          outcome.payment,
          {
            failureSummary: `정기 결제 첫 결제 실패 ${won(sub.amount)}: Toss 상태 ${outcome.payment.status} · 등록한 카드는 폐기`,
          },
        );
        await deleteRetiredBillingKey(result.retiredKey);
      } else {
        const { failFirstCharge } =
          await import("@/lib/payments/subscription-signup");
        await failFirstCharge({
          userId,
          subscriptionId: sub.id,
          paymentId: attempt.id,
          amount: sub.amount,
          reason: describeTossError(outcome.error),
          set: {
            raw: JSON.stringify({ error: describeTossError(outcome.error) }),
          },
        });
      }
      return;
    }
    const payment = outcome.payment;

    // The thank-you goes with the grant (lib/payments/payment-jobs); a doubled callback,
    // or the reconciler settling this order first, finds it already owed.
    await applyVerifiedTossPayment(attempt.id, payment, {
      from: now,
      notice: "thank_you",
    });
  });
}

// One executor for callback approvals and authenticated orders found by sweeps.
async function confirmOneTime(paymentId: string): Promise<void> {
  const owner = await db
    .selectFrom("payments")
    .select("user_id")
    .where("id", "=", paymentId)
    .executeTakeFirstOrThrow();
  await withAccountLock(owner.user_id, { waitMs: 0 }, async () => {
    const payment = await db
      .selectFrom("payments")
      .selectAll()
      .where("id", "=", paymentId)
      .executeTakeFirstOrThrow();
    if (payment.status !== "pending") return;
    if (
      payment.subscription_id ||
      !payment.attempt_key?.startsWith("one_time:") ||
      oneTimeYearsForAmount(payment.amount) === null ||
      !payment.toss_payment_key
    )
      throw new Error("One-time confirmation identity mismatch");
    // A previous approval may have succeeded before the ledger committed.
    // Resolve that first, even if the account's eligibility changed meanwhile.
    if (payment.charge_attempted_at) {
      const found = await lookupOrder(payment.order_id, "one-time");
      if (found.kind === "unknown") throw found.error;
      if (
        found.kind === "found" &&
        (found.payment.orderId !== payment.order_id ||
          found.payment.totalAmount !== payment.amount ||
          found.payment.paymentKey !== payment.toss_payment_key)
      )
        throw new Error("One-time payment lookup identity mismatch");
      if (found.kind === "found" && found.payment.status !== "IN_PROGRESS") {
        const result = await applyVerifiedTossPayment(
          payment.id,
          found.payment,
        );
        if (result.state === "pending")
          throw new Error("One-time approval is still pending");
        return;
      }
    }
    const account = await db
      .selectFrom("users")
      .select("deleted_at")
      .where("id", "=", payment.user_id)
      .executeTakeFirstOrThrow();
    if (account.deleted_at || (await oneTimeOrderSuperseded(payment))) {
      if (payment.charge_attempted_at)
        throw new Error("Superseded one-time approval outcome is unresolved");
      await db.transaction().execute(async (trx) => {
        await trx
          .updateTable("payments")
          .set({ status: "expired" })
          .where("id", "=", payment.id)
          .where("status", "=", "pending")
          .execute();
        await recordPaymentEvent(trx, {
          kind: "order_expired",
          userId: payment.user_id,
          paymentId: payment.id,
          summary:
            "계정 삭제나 다른 결제로 보내지 않은 한 번만 결제 주문을 종료",
        });
      });
      return;
    }
    const outcome = await confirmOrder({
      paymentKey: payment.toss_payment_key,
      orderId: payment.order_id,
      amount: payment.amount,
      firstKey: payment.charge_attempted_at
        ? `${payment.order_id}:${uuidv7()}`
        : payment.order_id,
      retryOnce: true,
      beforeSend: async () => {
        await db
          .updateTable("payments")
          .set({ charge_attempted_at: new Date() })
          .where("id", "=", payment.id)
          .execute();
      },
    });
    if (
      outcome.kind === "approved" ||
      (outcome.kind === "declined" && outcome.payment)
    ) {
      await applyVerifiedTossPayment(payment.id, outcome.payment!);
      return;
    }
    await db.transaction().execute(async (trx) => {
      if (outcome.kind === "declined")
        await trx
          .updateTable("payments")
          .set({
            status: "failed",
            raw: JSON.stringify({ error: describeTossError(outcome.error) }),
          })
          .where("id", "=", payment.id)
          .where("status", "=", "pending")
          .execute();
      await recordPaymentEvent(trx, {
        kind:
          outcome.kind === "declined" ? "charge_failed" : "charge_unresolved",
        userId: payment.user_id,
        paymentId: payment.id,
        summary: `한 번만 결제 ${won(payment.amount)} 승인: ${describeTossError(outcome.error)}`,
      });
    });
    if (outcome.kind === "unknown")
      throw new Error("One-time approval outcome is unknown");
  });
}
