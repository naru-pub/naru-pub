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
  MAX_PAYMENT_RETRY_ATTEMPTS,
} from "@/lib/subscriptions";

const CHARGE_LEASE_MINUTES = 30;
const BATCH_SIZE = 50;

type DueSubscription = {
  id: number;
  user_id: number;
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

// Renews active subscriptions whose next_billing_at has passed. On success the
// period extends contiguously and supporter_until advances. On failure the
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

async function claimDueSubscriptions(now: Date) {
  const staleLeaseBefore = new Date(
    now.getTime() - CHARGE_LEASE_MINUTES * 60 * 1000,
  );

  const result = await sql<DueSubscription>`
    UPDATE subscriptions
    SET charging_started_at = ${now}, updated_at = ${now}
    WHERE id IN (
      SELECT id
      FROM subscriptions
      WHERE status = 'active'
        AND toss_billing_key IS NOT NULL
        AND next_billing_at <= ${now}
        AND (
          charging_started_at IS NULL
          OR charging_started_at < ${staleLeaseBefore}
        )
      ORDER BY next_billing_at ASC, id ASC
      FOR UPDATE SKIP LOCKED
      LIMIT ${BATCH_SIZE}
    )
    RETURNING
      id,
      user_id,
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

async function getOrCreatePaymentAttempt(sub: DueSubscription) {
  const attemptKey = renewalAttemptKey(sub);
  const existing = await db
    .selectFrom("payments")
    .select(["id", "order_id", "status"])
    .where("attempt_key", "=", attemptKey)
    .executeTakeFirst();

  if (existing) return existing;

  try {
    return await db
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
  } catch (error) {
    const concurrent = await db
      .selectFrom("payments")
      .select(["id", "order_id", "status"])
      .where("attempt_key", "=", attemptKey)
      .executeTakeFirst();
    if (concurrent) return concurrent;
    throw error;
  }
}

async function markAttemptFailed(opts: {
  attempt: PaymentAttempt;
  sub: DueSubscription;
  failures: number;
  nextStatus: string;
  error: unknown;
}) {
  const now = new Date();
  await db.transaction().execute(async (trx) => {
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

    await trx
      .updateTable("subscriptions")
      .set({
        failed_charge_count: opts.failures,
        status: opts.nextStatus,
        charging_started_at: null,
        updated_at: now,
      })
      .where("id", "=", opts.sub.id)
      .execute();
  });
}

async function sendGraceNoticeIfNeeded(sub: DueSubscription) {
  if (sub.failed_charge_count !== 0) return;
  if (!sub.current_period_end) return;
  if (sub.payment_grace_notice_sent_at) {
    return;
  }

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
      graceEndsAt: addPaymentGrace(new Date(sub.current_period_end)),
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

async function main() {
  const now = new Date();

  const due = await claimDueSubscriptions(now);

  console.log(`[charge-subscriptions] ${due.length} subscription(s) due`);

  for (const sub of due) {
    const interval = sub.billing_interval as BillingInterval;
    const attempt = await getOrCreatePaymentAttempt(sub);

    if (attempt.status === "done") {
      await db
        .updateTable("subscriptions")
        .set({ charging_started_at: null, updated_at: new Date() })
        .where("id", "=", sub.id)
        .execute();
      console.log(
        `[charge-subscriptions] user ${sub.user_id}: attempt already done (${attempt.order_id})`,
      );
      continue;
    }

    try {
      let payment = null;
      try {
        const existingPayment = await getPaymentByOrderId(attempt.order_id);
        if (existingPayment.status === "DONE") {
          payment = existingPayment;
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
        await db
          .updateTable("subscriptions")
          .set({ charging_started_at: null, updated_at: new Date() })
          .where("id", "=", sub.id)
          .execute();
        console.error(
          `[charge-subscriptions] user ${sub.user_id}: ambiguous charge result; will reconcile ${attempt.order_id}: ${err}`,
        );
        continue;
      }
      const failures = sub.failed_charge_count + 1;
      const graceEndsAt = sub.current_period_end
        ? addPaymentGrace(new Date(sub.current_period_end))
        : now;
      const nextStatus =
        failures >= MAX_PAYMENT_RETRY_ATTEMPTS || graceEndsAt <= now
          ? "past_due"
          : "active";
      await markAttemptFailed({
        attempt,
        sub,
        failures,
        nextStatus,
        error: err,
      });
      await sendGraceNoticeIfNeeded(sub);
      console.error(
        `[charge-subscriptions] user ${sub.user_id}: charge failed (${failures}/${MAX_PAYMENT_RETRY_ATTEMPTS}) -> ${nextStatus}: ${err}`,
      );
    }
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("[charge-subscriptions] fatal:", error);
    process.exit(1);
  });
