import { db } from "@/lib/database";
import { sendSubscriptionPaymentGraceEmail } from "@/lib/email";
import { sql } from "kysely";
import {
  BillingInterval,
  chargeBillingKey,
  getPaymentByOrderId,
  isDefinitiveTossFailure,
  newOrderId,
  PLAN_ORDER_NAMES,
  TossApiError,
} from "@/lib/toss";
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
  id: number;
  user_id: number;
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
  id: number;
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
  seen: number[],
  only: number[] | null,
) {
  const leasedAt = new Date();
  const staleLeaseBefore = new Date(
    leasedAt.getTime() - CHARGE_LEASE_MINUTES * 60 * 1000,
  );
  const notSeen =
    seen.length > 0 ? sql`AND NOT (id = ANY(${seen}::int[]))` : sql``;
  const onlyThese = only ? sql`AND id = ANY(${only}::int[])` : sql``;

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
    await trx
      .updateTable("subscriptions")
      .set({
        failed_charge_count: opts.failures,
        status: opts.nextStatus,
        updated_at: now,
      })
      .where("id", "=", opts.sub.id)
      .where("status", "in", ["active", "scheduled"])
      .execute();
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
  await db
    .updateTable("subscriptions")
    .set({ status: "past_due", updated_at: now })
    .where("id", "=", sub.id)
    .where("status", "in", ["active", "scheduled"])
    .execute();
  console.error(
    `[charge-subscriptions] user ${sub.user_id}: grace period over with the charge still unresolved -> past_due`,
  );
}

// `subscriptionIds` limits the run to those subscriptions (the billing lab
// charges one at a time); the cron charges everything due.
export async function chargeDueSubscriptions(
  now = new Date(),
  opts: { subscriptionIds?: number[] } = {},
) {
  const seen: number[] = [];
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

    try {
      if (declined) {
        throw new TossApiError(
          `order ${attempt.order_id} was declined`,
          400,
          "ABORTED",
        );
      }
      let payment = null;
      try {
        const existingPayment = await getPaymentByOrderId(
          attempt.order_id,
          "billing",
        );
        if (existingPayment.status === "DONE") {
          payment = existingPayment;
        } else if (existingPayment.status === "ABORTED") {
          // Toss already declined this order, and an orderId is never
          // reused; charging it again would only replay the decline.
          throw new TossApiError(
            `order ${attempt.order_id} was declined`,
            400,
            "ABORTED",
          );
        }
      } catch (error) {
        if (!(error instanceof TossApiError && error.status === 404)) {
          throw error;
        }
      }

      payment ??= await chargeBillingKey({
        billingKey: sub.toss_billing_key,
        customerKey: sub.toss_customer_key,
        amount: sub.amount,
        orderId: attempt.order_id,
        orderName: PLAN_ORDER_NAMES[interval],
        idempotencyKey: attempt.order_id,
      });

      if (payment.status !== "DONE") {
        throw new Error(`unexpected payment status: ${payment.status}`);
      }

      // Keep periods contiguous, but never grant a period that's already in the past.
      const periodEnd = sub.current_period_end
        ? new Date(sub.current_period_end)
        : now;
      const base = periodEnd > now ? periodEnd : now;

      await applySuccessfulCharge({
        subscriptionId: sub.id,
        userId: sub.user_id,
        interval,
        amount: sub.amount,
        from: base,
        payment,
        paymentId: attempt.id,
      });
      console.log(`[charge-subscriptions] user ${sub.user_id}: renewed`);
    } catch (err) {
      if (!isDefinitiveTossFailure(err)) {
        // Toss may have completed the request. Preserve the attempt so the
        // next run reconciles the same order instead of charging a new one.
        await releaseLease(sub);
        await markPastDueAfterGrace(sub, now);
        console.error(
          `[charge-subscriptions] user ${sub.user_id}: ambiguous charge result; will reconcile ${attempt.order_id}: ${err}`,
        );
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
        error: err,
        // A declined order keeps the status and response Toss reported.
        keepAttemptStatus: declined,
      });
      await sendGraceNoticeIfNeeded(sub, now);
      console.error(
        `[charge-subscriptions] user ${sub.user_id}: charge failed (${failures}/${MAX_PAYMENT_RETRY_ATTEMPTS}) -> ${nextStatus}: ${err}`,
      );
    }
  }
}
