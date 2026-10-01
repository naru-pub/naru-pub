import { db } from "@/lib/database";
import { sendSubscriptionPaymentGraceEmail } from "@/lib/email";
import { sql } from "kysely";
import { sendChargeReceipt } from "@/lib/charge-receipts";
import {
  BillingInterval,
  chargeBillingKey,
  describeTossError,
  getPaymentByOrderId,
  newOrderId,
  PLAN_ORDER_NAMES,
  TossApiError,
  TossPaymentResult,
} from "@/lib/toss";
import { settleFailedOrder } from "@/lib/toss-orders";
import {
  notePaymentEvent,
  recordPaymentEvent,
  won,
} from "@/lib/payment-events";
import {
  addPaymentGrace,
  applySuccessfulCharge,
  CHARGE_LEASE_MINUTES,
  MAX_PAYMENT_RETRY_ATTEMPTS,
} from "@/lib/subscriptions";

// A claimed subscription holds its lease while the rest of its batch is
// charged, and a charge may take up to 90 seconds (the request timeout). Ten
// of them finish well inside CHARGE_LEASE_MINUTES, so no lease goes stale —
// and open to the subscribe flow — while its charge is still to come.
const BATCH_SIZE = 10;

type DueSubscription = {
  id: string;
  user_id: string;
  status: string;
  charging_started_at: Date;
  billing_interval: string;
  amount: number;
  toss_billing_key: string;
  toss_customer_key: string;
  current_period_end: Date | string | null;
  payment_grace_notice_sent_at: Date | string | null;
  failed_charge_count: number;
};

type PaymentAttempt = {
  id: string;
  order_id: string;
  status: string;
};

// Charges active renewals and scheduled first periods whose next_billing_at has
// passed. On success the period extends contiguously and supporter_until advances. On failure the
// attempt is retried on subsequent runs (next_billing_at stays in the past)
// until the retry limit or payment grace window ends, after which the
// subscription is marked past_due and grace-based access ends.

function renewalAttemptKey(sub: DueSubscription) {
  const periodEnd = sub.current_period_end
    ? new Date(sub.current_period_end).toISOString()
    : "none";
  const attemptNumber = sub.failed_charge_count + 1;
  return `subscription:${sub.id}:${periodEnd}:${attemptNumber}`;
}

// `seen` holds the subscriptions this run already tried. A failed or
// ambiguous charge leaves next_billing_at in the past and releases its lease,
// so without it the next batch would claim the same subscription again.
//
// `now` decides what is due; the lease itself is wall-clock time, taken per
// batch, so a later batch in a long run does not start with an aged lease.
async function claimDueSubscriptions(
  now: Date,
  seen: string[],
  only: string[] | null,
) {
  const leasedAt = new Date();
  const staleLeaseBefore = new Date(
    leasedAt.getTime() - CHARGE_LEASE_MINUTES * 60 * 1000,
  );
  const notSeen =
    seen.length > 0 ? sql`AND NOT (id = ANY(${seen}::uuid[]))` : sql``;
  const onlyThese = only ? sql`AND id = ANY(${only}::uuid[])` : sql``;

  const result = await sql<DueSubscription>`
    UPDATE subscriptions
    SET charging_started_at = ${leasedAt}, updated_at = ${leasedAt}
    WHERE id IN (
      SELECT id
      FROM subscriptions
      WHERE status IN ('active', 'scheduled')
        AND toss_billing_key IS NOT NULL
        AND next_billing_at <= ${now}
        AND (
          charging_started_at IS NULL
          OR charging_started_at < ${staleLeaseBefore}
        )
        ${notSeen}
        ${onlyThese}
      ORDER BY next_billing_at ASC, id ASC
      FOR UPDATE SKIP LOCKED
      LIMIT ${BATCH_SIZE}
    )
    RETURNING
      id,
      user_id,
      status,
      charging_started_at,
      billing_interval,
      amount,
      toss_billing_key,
      toss_customer_key,
      current_period_end,
      payment_grace_notice_sent_at,
      failed_charge_count
  `.execute(db);

  return result.rows;
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
async function getOrCreatePaymentAttempt(
  sub: DueSubscription,
): Promise<{ attempt: PaymentAttempt; declined: boolean }> {
  const baseKey = renewalAttemptKey(sub);
  const attemptsForTry = () =>
    db
      .selectFrom("payments")
      .select(["id", "order_id", "status"])
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
  if (attempts[0]?.status === "aborted") {
    return { attempt: attempts[0], declined: true };
  }

  const attemptKey =
    attempts.length === 0 ? baseKey : `${baseKey}:r${attempts.length}`;
  try {
    const attempt = await db
      .insertInto("payments")
      .values({
        attempt_key: attemptKey,
        user_id: sub.user_id,
        subscription_id: sub.id,
        order_id: newOrderId(),
        amount: sub.amount,
        status: "pending",
      })
      .returning(["id", "order_id", "status"])
      .executeTakeFirstOrThrow();
    return { attempt, declined: false };
  } catch (error) {
    const concurrent = (await attemptsForTry()).find((attempt) =>
      LIVE_ATTEMPT_STATUSES.has(attempt.status),
    );
    if (concurrent) return { attempt: concurrent, declined: false };
    throw error;
  }
}

// The subscription was claimed before the attempt row was prepared. Before
// the card is charged, confirm that nobody canceled, refunded or switched it in
// the meantime and that the lease is still ours.
async function stillChargeable(sub: DueSubscription): Promise<boolean> {
  const current = await db
    .selectFrom("subscriptions")
    .select(["status", "toss_billing_key", "charging_started_at"])
    .where("id", "=", sub.id)
    .executeTakeFirst();
  return (
    current != null &&
    (current.status === "active" || current.status === "scheduled") &&
    current.toss_billing_key === sub.toss_billing_key &&
    current.charging_started_at != null &&
    new Date(current.charging_started_at).getTime() ===
      new Date(sub.charging_started_at).getTime()
  );
}

async function releaseLease(sub: DueSubscription) {
  await db
    .updateTable("subscriptions")
    .set({ charging_started_at: null, updated_at: new Date() })
    .where("id", "=", sub.id)
    .where("charging_started_at", "=", new Date(sub.charging_started_at))
    .execute();
}

async function markAttemptFailed(opts: {
  attempt: PaymentAttempt;
  sub: DueSubscription;
  failures: number;
  nextStatus: string;
  error: unknown;
  keepAttemptStatus?: boolean;
}) {
  const now = new Date();
  await db.transaction().execute(async (trx) => {
    if (!opts.keepAttemptStatus) {
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

    // A cancel, refund or one-time switch that landed mid-charge wins: its
    // status must not be overwritten back to active or past_due.
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
    const reason =
      opts.error instanceof Error ? opts.error.message : String(opts.error);
    await recordPaymentEvent(trx, {
      kind: "charge_failed",
      userId: opts.sub.user_id,
      paymentId: opts.attempt.id,
      subscriptionId: opts.sub.id,
      summary: `갱신 결제 실패 ${won(opts.sub.amount)} (${opts.failures}/${MAX_PAYMENT_RETRY_ATTEMPTS}회): ${reason}`,
    });
    if (
      Number(updated.numUpdatedRows ?? 0) > 0 &&
      opts.nextStatus === "past_due"
    ) {
      await recordPaymentEvent(trx, {
        kind: "past_due",
        userId: opts.sub.user_id,
        subscriptionId: opts.sub.id,
        summary: `재시도 한도나 유예 기간에 도달해 연체(past_due)로 전환`,
      });
    }
    await trx
      .updateTable("subscriptions")
      .set({ charging_started_at: null })
      .where("id", "=", opts.sub.id)
      .execute();
  });
}

async function sendGraceNoticeIfNeeded(sub: DueSubscription, now: Date) {
  if (sub.failed_charge_count !== 0) return;
  if (!sub.current_period_end) return;
  if (sub.payment_grace_notice_sent_at) {
    return;
  }
  const graceEndsAt = addPaymentGrace(new Date(sub.current_period_end));
  // A grace notice whose grace period has already ended would tell the user
  // they still have time they do not have.
  if (graceEndsAt <= now) return;

  const user = await db
    .selectFrom("users")
    .select(["email", "email_verified_at", "login_name"])
    .where("id", "=", sub.user_id)
    .executeTakeFirst();

  if (!user?.email || !user.email_verified_at) return;

  try {
    await sendSubscriptionPaymentGraceEmail({
      email: user.email,
      loginName: user.login_name,
      amount: sub.amount,
      graceEndsAt,
    });

    await db
      .updateTable("subscriptions")
      .set({
        payment_grace_notice_sent_at: new Date(),
        updated_at: new Date(),
      })
      .where("id", "=", sub.id)
      .execute();

    console.log(
      `[charge-subscriptions] user ${sub.user_id}: payment grace notice sent`,
    );
  } catch (error) {
    console.error(
      `[charge-subscriptions] user ${sub.user_id}: failed to send payment grace notice:`,
      error,
    );
  }
}

// A subscription whose charges keep ending ambiguously (Toss 5xx, timeouts)
// never gets a definitive failure to count, and its pending order must keep
// its number — a new one could charge the card twice. Once the grace period is
// over it is still past due; the reconciler revives it if the order turns out
// to have been paid.
async function markPastDueAfterGrace(sub: DueSubscription, now: Date) {
  if (!sub.current_period_end) return;
  if (addPaymentGrace(new Date(sub.current_period_end)) > now) return;
  const updated = await db
    .updateTable("subscriptions")
    .set({ status: "past_due", updated_at: now })
    .where("id", "=", sub.id)
    .where("status", "in", ["active", "scheduled"])
    .executeTakeFirst();
  if (Number(updated.numUpdatedRows ?? 0) > 0) {
    await notePaymentEvent({
      kind: "past_due",
      userId: sub.user_id,
      subscriptionId: sub.id,
      summary:
        "유예 기간이 끝났는데 갱신 결제 결과가 아직 불분명해 연체(past_due)로 전환",
    });
  }
  console.error(
    `[charge-subscriptions] user ${sub.user_id}: grace period over with the charge still unresolved -> past_due`,
  );
}

// `subscriptionIds` limits the run to those subscriptions (the billing lab
// charges one at a time); the cron charges everything due.
export async function chargeDueSubscriptions(
  now = new Date(),
  opts: { subscriptionIds?: string[] } = {},
) {
  const seen: string[] = [];
  for (;;) {
    const due = await claimDueSubscriptions(
      now,
      seen,
      opts.subscriptionIds ?? null,
    );
    if (due.length === 0) break;
    seen.push(...due.map((sub) => sub.id));
    await chargeClaimedSubscriptions(due, now);
  }
  console.log(`[charge-subscriptions] ${seen.length} subscription(s) due`);
}

type ChargeOutcome =
  | { state: "paid"; payment: TossPaymentResult }
  | { state: "refused"; error: unknown; keepAttemptStatus: boolean }
  | { state: "unknown"; error: unknown };

function declinedOrder(attempt: PaymentAttempt) {
  return new TossApiError(
    `order ${attempt.order_id} was declined`,
    400,
    "ABORTED",
  );
}

// Charges one claimed attempt and says what became of it. A failed call is
// not taken as a failed payment until the order agrees (settleFailedOrder):
// Toss can answer an approved order with an error, and a failure counts
// against the card and may end in past_due.
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
  try {
    const existingPayment = await getPaymentByOrderId(
      attempt.order_id,
      "billing",
    );
    if (existingPayment.status === "DONE") {
      return { state: "paid", payment: existingPayment };
    }
    if (existingPayment.status === "ABORTED") {
      // Toss already declined this order, and an orderId is never
      // reused; charging it again would only replay the decline.
      return {
        state: "refused",
        error: declinedOrder(attempt),
        keepAttemptStatus: false,
      };
    }
  } catch (error) {
    if (!(error instanceof TossApiError && error.status === 404)) {
      return { state: "unknown", error };
    }
  }

  let payment: TossPaymentResult;
  try {
    payment = await chargeBillingKey({
      billingKey: sub.toss_billing_key,
      customerKey: sub.toss_customer_key,
      amount: sub.amount,
      orderId: attempt.order_id,
      orderName: PLAN_ORDER_NAMES[sub.billing_interval as BillingInterval],
      idempotencyKey: attempt.order_id,
    });
  } catch (error) {
    const settled = await settleFailedOrder({
      orderId: attempt.order_id,
      amount: sub.amount,
      flow: "billing",
      error,
    });
    if (settled.state === "paid") {
      return { state: "paid", payment: settled.payment };
    }
    return settled.state === "refused"
      ? { state: "refused", error, keepAttemptStatus: false }
      : { state: "unknown", error };
  }
  if (payment.status !== "DONE") {
    return {
      state: "unknown",
      error: new Error(`unexpected payment status: ${payment.status}`),
    };
  }
  return { state: "paid", payment };
}

// Toss may have completed the request. Preserve the attempt so the next run
// reconciles the same order instead of charging a new one.
async function leaveUnresolved(
  sub: DueSubscription,
  attempt: PaymentAttempt,
  error: unknown,
  now: Date,
) {
  await releaseLease(sub);
  await notePaymentEvent({
    kind: "charge_unresolved",
    userId: sub.user_id,
    paymentId: attempt.id,
    subscriptionId: sub.id,
    summary: `갱신 결제 ${won(sub.amount)} 결과 불분명, 같은 주문(${attempt.order_id})으로 다시 확인 예정: ${describeTossError(error)}`,
  });
  await markPastDueAfterGrace(sub, now);
  console.error(
    `[charge-subscriptions] user ${sub.user_id}: ambiguous charge result; will reconcile ${attempt.order_id}: ${describeTossError(error)}`,
  );
}

async function chargeClaimedSubscriptions(due: DueSubscription[], now: Date) {
  for (const sub of due) {
    const interval = sub.billing_interval as BillingInterval;
    const { attempt, declined } = await getOrCreatePaymentAttempt(sub);

    if (attempt.status === "done") {
      await releaseLease(sub);
      console.log(
        `[charge-subscriptions] user ${sub.user_id}: attempt already done (${attempt.order_id})`,
      );
      continue;
    }

    if (!(await stillChargeable(sub))) {
      await releaseLease(sub);
      console.log(
        `[charge-subscriptions] user ${sub.user_id}: stopped before charging; skipped`,
      );
      continue;
    }

    const outcome = await chargeAttempt(sub, attempt, declined);

    if (outcome.state === "paid") {
      // Keep periods contiguous, but never grant a period that's already in the past.
      const periodEnd = sub.current_period_end
        ? new Date(sub.current_period_end)
        : now;
      const base = periodEnd > now ? periodEnd : now;
      try {
        const { granted } = await applySuccessfulCharge({
          subscriptionId: sub.id,
          userId: sub.user_id,
          interval,
          amount: sub.amount,
          from: base,
          payment: outcome.payment,
          paymentId: attempt.id,
        });
        if (granted) await sendChargeReceipt(attempt.id);
      } catch (error) {
        await leaveUnresolved(sub, attempt, error, now);
        continue;
      }
      console.log(`[charge-subscriptions] user ${sub.user_id}: renewed`);
      continue;
    }

    if (outcome.state === "unknown") {
      await leaveUnresolved(sub, attempt, outcome.error, now);
      continue;
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
    });
    await sendGraceNoticeIfNeeded(sub, now);
    console.error(
      `[charge-subscriptions] user ${sub.user_id}: charge failed (${failures}/${MAX_PAYMENT_RETRY_ATTEMPTS}) -> ${nextStatus}: ${describeTossError(outcome.error)}`,
    );
  }
}
