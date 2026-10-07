import { applyVerifiedTossPayment } from "@/lib/payments/payment-facts";
import { db } from "@/lib/database";
import type {
  PaymentStatus,
  SubscriptionStatus,
} from "@/lib/payments/payment-states";
import type { Executor } from "@/lib/entitlements";
import { enqueueJob } from "@/lib/payments/payment-jobs";
import { sql } from "kysely";
import {
  BillingInterval,
  configuredMid,
  describeTossError,
  isTossLiveMode,
  withNewOrderId,
  PLAN_ORDER_NAMES,
  TossApiError,
  TossPaymentResult,
} from "@/lib/payments/toss";
import { chargeOrder } from "@/lib/payments/toss-gateway";
import {
  notePaymentEvent,
  recordPaymentEvent,
  won,
} from "@/lib/payments/payment-events";
import {
  addPaymentGrace,
  MAX_PAYMENT_RETRY_ATTEMPTS,
} from "@/lib/payments/subscriptions";
import { withAccountLock } from "@/lib/payments/account-lock";
import { renewalCutoff } from "@/lib/payments/renewal-time";
export { RENEWAL_HOUR_KST, renewalCutoff } from "@/lib/payments/renewal-time";

// Renewals are charged at 09:00 KST: the run then charges every subscription
// due by that time. The job also runs every hour after it, so a run missed for
// a deploy or a database blip is made up the same day — but it only charges
// what was due by the last 09:00, and each subscription is tried at most once
// in MIN_HOURS_BETWEEN_TRIES, so the retries inside the grace period stay a
// day apart. A subscription that falls due after 09:00 waits for the next
// day's. An explicit charge (a card change, the billing lab) is not held to
// either.
const MIN_HOURS_BETWEEN_TRIES = 20;

type DueSubscription = {
  id: string;
  user_id: string;
  status: SubscriptionStatus;
  billing_interval: string;
  amount: number;
  // The plan's key and its customerKey.
  billing_key: string;
  customer_key: string;
  // The MID that issued the key (billing_keys.toss_mid).
  key_mid: string | null;
  current_period_end: Date | string | null;
  payment_grace_notice_sent_at: Date | string | null;
  failed_charge_count: number;
};

type PaymentAttempt = {
  id: string;
  order_id: string;
  status: PaymentStatus;
  charge_attempted_at: Date | string | null;
};

// Charges active renewals and scheduled first periods whose next_billing_at has
// passed. On success the period extends contiguously and supporter_until advances. On failure the
// attempt is retried on later days (next_billing_at stays in the past)
// until the retry limit or payment grace window ends, after which the
// subscription is marked past_due and grace-based access ends.

function renewalAttemptKey(sub: DueSubscription) {
  const periodEnd = sub.current_period_end
    ? new Date(sub.current_period_end).toISOString()
    : "none";
  const attemptNumber = sub.failed_charge_count + 1;
  return `subscription:${sub.id}:${periodEnd}:${attemptNumber}`;
}

// The subscriptions due now: active or scheduled, holding a key, past
// next_billing_at, not a lifetime comp, and (unless named explicitly) not
// tried in the last MIN_HOURS_BETWEEN_TRIES. Read once to list the run's work
// and again under each account's lock, where it decides.
function dueSubscriptions(
  now: Date,
  opts: { only: string[] | null; explicit: boolean; dueBy: Date },
) {
  const triedSince = new Date(
    now.getTime() - MIN_HOURS_BETWEEN_TRIES * 60 * 60 * 1000,
  );
  const onlyThese = opts.only
    ? sql`AND s.id = ANY(${opts.only}::uuid[])`
    : sql``;
  const notTriedToday = opts.explicit
    ? sql``
    : sql`AND NOT EXISTS (
        SELECT 1 FROM payments p
        WHERE p.subscription_id = s.id AND p.charge_attempted_at > ${triedSince}
      )`;
  return sql<DueSubscription>`
    SELECT
      s.id,
      s.user_id,
      s.status,
      s.billing_interval,
      s.amount,
      k.billing_key,
      k.customer_key,
      k.toss_mid AS key_mid,
      s.current_period_end,
      s.payment_grace_notice_sent_at,
      s.failed_charge_count
    FROM subscriptions s
    JOIN billing_keys k ON k.id = s.billing_key_id AND k.status = 'active'
    WHERE s.status IN ('active', 'scheduled')
      AND s.next_billing_at <= ${opts.dueBy}
      -- A lifetime comp is never charged, whatever plan it still has.
      AND NOT EXISTS (
        SELECT 1 FROM users u WHERE u.id = s.user_id AND u.supporter_comp
      )
      -- An accepted refund must settle before this plan can charge again.
      AND NOT EXISTS (SELECT 1 FROM payments p
        WHERE p.refund_subscription_id = s.id AND p.refund_requested_at IS NOT NULL
          AND p.refunded_amount = 0)
      ${notTriedToday}
      ${onlyThese}
    ORDER BY s.next_billing_at ASC, s.id ASC
  `.execute(db);
}

// Statuses under which an order is still worth asking Toss about again.
const LIVE_ATTEMPT_STATUSES = new Set(["pending", "done"]);

// Returns the order to charge for this renewal try, or a declined one.
//
// Toss never reuses an orderId, and it replays the first response for an
// idempotency key — errors included — for 15 days. So a pending order is
// retried as is (Toss may have charged it), but once Toss has shown the order
// went nowhere (the reconciler marks it expired), the next try gets a new
// order and key rather than replaying the same failure until the key expires.
// An order Toss reports as ABORTED was declined; that is counted as a failed
// try instead of being charged again.
//
// After a card change (newCard), an order the old card declined is not
// counted again: it is replaced by a new order on the new card, as an order
// Toss never saw would be.
async function getOrCreatePaymentAttempt(
  sub: DueSubscription,
  newCard = false,
): Promise<{ attempt: PaymentAttempt; declined: boolean }> {
  const baseKey = renewalAttemptKey(sub);
  const attemptsForTry = () =>
    db
      .selectFrom("payments")
      .select(["id", "order_id", "status", "charge_attempted_at"])
      .where((eb) =>
        eb.or([
          eb("attempt_key", "=", baseKey),
          eb("attempt_key", "like", `${baseKey}:r%`),
        ]),
      )
      .orderBy("id", "desc")
      .execute();

  const attempts = await attemptsForTry();
  const live = attempts.find((attempt) =>
    LIVE_ATTEMPT_STATUSES.has(attempt.status),
  );
  if (live) return { attempt: live, declined: false };
  if (attempts[0]?.status === "aborted" && !newCard) {
    return { attempt: attempts[0], declined: true };
  }

  const attemptKey =
    attempts.length === 0 ? baseKey : `${baseKey}:r${attempts.length}`;
  try {
    const attempt = await withNewOrderId((orderId) =>
      db
        .insertInto("payments")
        .values({
          attempt_key: attemptKey,
          user_id: sub.user_id,
          subscription_id: sub.id,
          order_id: orderId,
          amount: sub.amount,
          status: "pending",
        })
        .returning(["id", "order_id", "status", "charge_attempted_at"])
        .executeTakeFirstOrThrow(),
    );
    return { attempt, declined: false };
  } catch (error) {
    const concurrent = (await attemptsForTry()).find((attempt) =>
      LIVE_ATTEMPT_STATUSES.has(attempt.status),
    );
    if (concurrent) return { attempt: concurrent, declined: false };
    throw error;
  }
}

async function markAttemptFailed(opts: {
  attempt: PaymentAttempt;
  sub: DueSubscription;
  failures: number;
  nextStatus: SubscriptionStatus;
  error: unknown;
  keepAttemptStatus?: boolean;
  payment?: TossPaymentResult | null;
}): Promise<{ jobs: Array<string | null> }> {
  const now = new Date();
  return db.transaction().execute(async (trx) => {
    const reason =
      opts.error instanceof Error ? opts.error.message : String(opts.error);
    const summary = `갱신 결제 실패 ${won(opts.sub.amount)} (${opts.failures}/${MAX_PAYMENT_RETRY_ATTEMPTS}회): ${reason}`;
    if (opts.payment) {
      await applyVerifiedTossPayment(opts.attempt.id, opts.payment, {
        transaction: trx,
        failureSummary: summary,
      });
    } else if (!opts.keepAttemptStatus) {
      await trx
        .updateTable("payments")
        .set({
          status: "failed",
          raw: JSON.stringify({
            error:
              opts.error instanceof Error
                ? opts.error.message
                : String(opts.error),
          }),
        })
        .where("id", "=", opts.attempt.id)
        .execute();
    }

    // A plan stopped since it was read (by a grant of the same order, say)
    // keeps that state; it is not overwritten back to active or past_due.
    const updated = await trx
      .updateTable("subscriptions")
      .set({
        failed_charge_count: opts.failures,
        status: opts.nextStatus,
        updated_at: now,
      })
      .where("id", "=", opts.sub.id)
      .where("status", "in", ["active", "scheduled"])
      .executeTakeFirst();
    if (!opts.payment)
      await recordPaymentEvent(trx, {
        kind: "charge_failed",
        userId: opts.sub.user_id,
        paymentId: opts.attempt.id,
        subscriptionId: opts.sub.id,
        summary,
      });
    const wentPastDue =
      Number(updated.numUpdatedRows ?? 0) > 0 && opts.nextStatus === "past_due";
    if (wentPastDue) {
      await recordPaymentEvent(trx, {
        kind: "past_due",
        userId: opts.sub.user_id,
        subscriptionId: opts.sub.id,
        summary: `재시도 한도나 유예 기간에 도달해 연체(past_due)로 전환`,
      });
    }
    // Counting a decline Toss reported earlier is today's try for this
    // subscription, even though nothing was sent now.
    await trx
      .updateTable("payments")
      .set({ charge_attempted_at: now })
      .where("id", "=", opts.attempt.id)
      .execute();
    return {
      jobs: [
        await enqueueGraceNotice(trx, opts.sub, now),
        wentPastDue
          ? await enqueuePastDueNotice(trx, opts.sub, {
              reason: "declined",
              declinedAttempts: opts.failures,
            })
          : null,
      ],
    };
  });
}

// Sent after a decline while the grace period lasts, once per lapse: the
// dedupe key is the period that lapsed, and the job (lib/payments/payment-jobs) sets
// payment_grace_notice_sent_at once it went out.
async function enqueueGraceNotice(
  trx: Executor,
  sub: DueSubscription,
  now: Date,
): Promise<string | null> {
  if (!sub.current_period_end || sub.payment_grace_notice_sent_at) return null;
  const periodEnd = new Date(sub.current_period_end);
  // A grace notice whose grace period has already ended would tell the user
  // they still have time they do not have.
  if (addPaymentGrace(periodEnd) <= now) return null;
  return enqueueJob(
    trx,
    { kind: "grace_notice", subscriptionId: sub.id },
    { dedupeKey: `grace_notice:${sub.id}:${periodEnd.toISOString()}` },
  );
}

// Tells the supporter their plan stopped renewing. Enqueued only by the
// update that moved it to past_due, and once per lapsed period.
async function enqueuePastDueNotice(
  trx: Executor,
  sub: DueSubscription,
  opts: { reason: "declined" | "unresolved"; declinedAttempts?: number },
): Promise<string | null> {
  const periodEnd = sub.current_period_end
    ? new Date(sub.current_period_end).toISOString()
    : "none";
  return enqueueJob(
    trx,
    {
      kind: "past_due_notice",
      subscriptionId: sub.id,
      reason: opts.reason,
      declinedAttempts: opts.declinedAttempts,
    },
    { dedupeKey: `past_due_notice:${sub.id}:${periodEnd}` },
  );
}

// A subscription whose charges keep ending ambiguously (Toss 5xx, timeouts)
// never gets a definitive failure to count, and its pending order must keep
// its number — a new one could charge the card twice. Once the grace period is
// over it is still past due; the reconciler revives it if the order turns out
// to have been paid.
async function markPastDueAfterGrace(sub: DueSubscription, now: Date) {
  if (!sub.current_period_end) return;
  if (addPaymentGrace(new Date(sub.current_period_end)) > now) return;
  // Only the period this run saw: a reconciler that granted the order in the
  // meantime moved it on, and that plan is paid, not past due.
  await db.transaction().execute(async (trx) => {
    const updated = await trx
      .updateTable("subscriptions")
      .set({ status: "past_due", updated_at: now })
      .where("id", "=", sub.id)
      .where("status", "in", ["active", "scheduled"])
      .where("current_period_end", "=", new Date(sub.current_period_end!))
      .executeTakeFirst();
    if (Number(updated.numUpdatedRows ?? 0) === 0) return null;
    await recordPaymentEvent(trx, {
      kind: "past_due",
      userId: sub.user_id,
      subscriptionId: sub.id,
      summary:
        "유예 기간이 끝났는데 갱신 결제 결과가 아직 불분명해 연체(past_due)로 전환",
    });
    return enqueuePastDueNotice(trx, sub, { reason: "unresolved" });
  });

  console.error(
    `[charge-subscriptions] user ${sub.user_id}: grace period over with the charge still unresolved -> past_due`,
  );
}

// The hourly renewal run: one renew_subscription payment job per plan due by
// the last 09:00 KST (lib/payments/payment-jobs), run right away. The dedupe key is the
// plan and that day's cutoff, so a plan gets one try a day however often the
// run comes. A job whose account is busy, or that fails with an error, is
// tried again by the job queue within minutes instead of at the next run.
export async function enqueueDueRenewals(now = new Date()): Promise<{
  due: number;
  jobs: Array<string | null>;
}> {
  const dueBy = renewalCutoff(now);
  const due = (
    await dueSubscriptions(now, { only: null, explicit: false, dueBy })
  ).rows;
  const jobs: Array<string | null> = [];
  for (const sub of due) {
    jobs.push(
      await enqueueJob(
        db,
        { kind: "renew_subscription", subscriptionId: sub.id },
        { dedupeKey: `renew:${sub.id}:${dueBy.toISOString()}` },
      ),
    );
  }
  return { due: due.length, jobs };
}

// A renew_subscription job: charges the plan if it is still due — read again
// under its account's lock, by the same rules as the run that queued it.
// Throws AccountBusyError when the account is busy, which the job queue
// retries shortly without counting it.
export async function renewSubscription(
  subscriptionId: string,
  now = new Date(),
  opts: {
    cardRegistrationId?: string;
    lab?: boolean;
    dueBy?: Date;
    explicit?: boolean;
    newCard?: boolean;
  } = {},
): Promise<void> {
  const owner = await db
    .selectFrom("subscriptions")
    .select("user_id")
    .where("id", "=", subscriptionId)
    .executeTakeFirst();
  if (!owner) return;
  await withAccountLock(owner.user_id, { waitMs: 0 }, async () => {
    const explicit =
      opts.cardRegistrationId != null ||
      opts.lab === true ||
      opts.explicit === true;
    if (opts.cardRegistrationId) {
      const registration = await db
        .selectFrom("card_registrations as r")
        .innerJoin("subscriptions as s", "s.id", "r.subscription_id")
        .select("r.id")
        .where("r.id", "=", opts.cardRegistrationId!)
        .where("s.id", "=", subscriptionId)
        .where("r.completed_at", "is not", null)
        .whereRef("r.billing_key_id", "=", "s.billing_key_id")
        .executeTakeFirst();
      if (!registration) return; // A newer card or cancellation superseded this task.
    }
    const [sub] = (
      await dueSubscriptions(now, {
        only: [subscriptionId],
        explicit,
        dueBy: opts.dueBy ?? (explicit ? now : renewalCutoff(now)),
      })
    ).rows;
    if (sub)
      await chargeSubscription(
        sub,
        now,
        opts.cardRegistrationId != null || opts.newCard === true,
      );
  });
}

type ChargeOutcome =
  | { state: "paid"; payment: TossPaymentResult }
  | {
      state: "refused";
      error: unknown;
      keepAttemptStatus: boolean;
      payment?: TossPaymentResult | null;
    }
  // sent: whether a charge for this order has ever gone to Toss. An order
  // only looked up (Toss down before anything was sent) cannot have charged.
  | { state: "unknown"; error: unknown; sent: boolean };

function declinedOrder(attempt: PaymentAttempt) {
  return new TossApiError(
    `order ${attempt.order_id} was declined`,
    400,
    "ABORTED",
  );
}

// Charges one attempt and says what became of it (lib/payments/toss-gateway): a
// failed call is not a failed payment until the order agrees, and a failure
// counts against the card and may end in past_due.
async function chargeAttempt(
  sub: DueSubscription,
  attempt: PaymentAttempt,
  declined: boolean,
): Promise<ChargeOutcome> {
  if (declined) {
    return {
      state: "refused",
      error: declinedOrder(attempt),
      // A declined order keeps the status and response Toss reported.
      keepAttemptStatus: true,
    };
  }
  const account = await db
    .selectFrom("users")
    .select("login_name")
    .where("id", "=", sub.user_id)
    .executeTakeFirstOrThrow();
  const outcome = await chargeOrder({
    billingKey: sub.billing_key,
    customerKey: sub.customer_key,
    amount: sub.amount,
    orderId: attempt.order_id,
    orderName: PLAN_ORDER_NAMES[sub.billing_interval as BillingInterval],
    customerName: account.login_name,
    sentBefore: attempt.charge_attempted_at != null,
    // Recorded before the call: an order Toss has not heard of is expired 45
    // minutes after its last attempt, not its creation, so a charge Toss may
    // still be approving is never expired under it.
    beforeSend: async () => {
      await db
        .updateTable("payments")
        .set({ charge_attempted_at: new Date() })
        .where("id", "=", attempt.id)
        .execute();
    },
  });
  if (outcome.kind === "approved") {
    return { state: "paid", payment: outcome.payment };
  }
  if (outcome.kind === "declined") {
    return {
      state: "refused",
      error: outcome.error,
      keepAttemptStatus: false,
      payment: outcome.payment,
    };
  }
  return { state: "unknown", error: outcome.error, sent: outcome.sent };
}

// Toss may have completed the request. Preserve the attempt so the next run
// reconciles the same order instead of charging a new one.
//
// Only a charge that was sent can end in past_due: if Toss was down before
// anything reached it, the card was never tried, and the plan is tried again
// on the next run rather than stopped for good.
async function leaveUnresolved(
  sub: DueSubscription,
  attempt: PaymentAttempt,
  error: unknown,
  now: Date,
  sent: boolean,
) {
  await notePaymentEvent({
    kind: "charge_unresolved",
    userId: sub.user_id,
    paymentId: attempt.id,
    subscriptionId: sub.id,
    summary: `갱신 결제 ${won(sub.amount)} 결과 불분명, 같은 주문(${attempt.order_id})으로 다시 확인 예정: ${describeTossError(error)}`,
  });
  if (sent) await markPastDueAfterGrace(sub, now);
  console.error(
    `[charge-subscriptions] user ${sub.user_id}: ambiguous charge result; will reconcile ${attempt.order_id}: ${describeTossError(error)}`,
  );
}

// Charges one due subscription. Runs under its account's lock.
// Why the plan's key cannot be charged through the billing secret key in use,
// or null when it can. A key is chargeable only through the MID that issued
// it: one of another MID — a test-mode key once the live keys are in — would
// be refused, and counting that as the card's decline would mail the
// supporter a failure that is 나루's. TOSS_BILLING_MID names the MID of
// TOSS_BILLING_SECRET_KEY; live mode charges nothing without it.
export function keyMidProblem(keyMid: string | null): string | null {
  const expected = configuredMid("billing");
  if (!expected) {
    return isTossLiveMode() ? "TOSS_BILLING_MID가 설정되지 않음" : null;
  }
  if (keyMid === expected) return null;
  return `빌링키의 MID ${keyMid ?? "(기록 없음)"}, 현재 키의 MID ${expected}`;
}

async function chargeSubscription(
  sub: DueSubscription,
  now: Date,
  newCard: boolean,
) {
  // Not charged, and nothing counted against the card: the plan stays due,
  // and the operators hear of it once a day (renewal jobs are daily).
  const midProblem = keyMidProblem(sub.key_mid);
  if (midProblem) {
    await notePaymentEvent({
      kind: "billing_mid_mismatch",
      userId: sub.user_id,
      subscriptionId: sub.id,
      summary: `정기 결제 ${won(sub.amount)} 청구하지 않음: ${midProblem}`,
    });
    console.error(
      `[charge-subscriptions] subscription ${sub.id}: not charged, ${midProblem}`,
    );
    return;
  }
  const { attempt, declined } = await getOrCreatePaymentAttempt(sub, newCard);

  if (attempt.status === "done") {
    console.log(
      `[charge-subscriptions] user ${sub.user_id}: attempt already done (${attempt.order_id})`,
    );
    return;
  }

  const outcome = await chargeAttempt(sub, attempt, declined);

  if (outcome.state === "paid") {
    // Keep periods contiguous, but never grant a period that's already in the past.
    const periodEnd = sub.current_period_end
      ? new Date(sub.current_period_end)
      : now;
    const base = periodEnd > now ? periodEnd : now;
    try {
      await applyVerifiedTossPayment(attempt.id, outcome.payment, {
        from: base,
        notice: "receipt",
      });
    } catch (error) {
      await leaveUnresolved(sub, attempt, error, now, true);
      return;
    }
    console.log(`[charge-subscriptions] user ${sub.user_id}: renewed`);
    return;
  }

  if (outcome.state === "unknown") {
    await leaveUnresolved(sub, attempt, outcome.error, now, outcome.sent);
    return;
  }

  const failures = sub.failed_charge_count + 1;
  const graceEndsAt = sub.current_period_end
    ? addPaymentGrace(new Date(sub.current_period_end))
    : now;
  // A scheduled first charge that fails has still never been paid, so it
  // stays scheduled while it retries rather than claiming to be active.
  const nextStatus =
    failures >= MAX_PAYMENT_RETRY_ATTEMPTS || graceEndsAt <= now
      ? "past_due"
      : sub.status;
  await markAttemptFailed({
    attempt,
    sub,
    failures,
    nextStatus,
    error: outcome.error,
    keepAttemptStatus: outcome.keepAttemptStatus,
    payment: outcome.payment,
  });

  console.error(
    `[charge-subscriptions] user ${sub.user_id}: charge failed (${failures}/${MAX_PAYMENT_RETRY_ATTEMPTS}) -> ${nextStatus}: ${describeTossError(outcome.error)}`,
  );
}
