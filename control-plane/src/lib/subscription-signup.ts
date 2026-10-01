import { randomUUID } from "crypto";
import type { Updateable } from "kysely";
import { db } from "@/lib/database";
import type { DB } from "@/lib/db";
import {
  deleteRetiredBillingKey,
  discardIssuedBillingKey,
  retireBillingKey,
} from "@/lib/billing-keys";
import { sendSupportThankYouEmail } from "@/lib/email";
import { reconcilePayment } from "@/lib/payment-reconciliation";
import {
  canStartRecurringPurchase,
  scheduledRecurringStart,
} from "@/lib/support-purchases";
import {
  applySuccessfulCharge,
  CHARGE_LEASE_MINUTES,
  claimSubscriptionForConfirm,
  releaseSubscriptionLease,
  retireUnusedSignupKey,
  scheduleSubscriptionStart,
} from "@/lib/subscriptions";
import {
  BillingInterval,
  chargeBillingKey,
  getPaymentByOrderId,
  isDefinitiveTossFailure,
  issueBillingKey,
  newOrderId,
  paymentProviderMetadata,
  PLAN_AMOUNTS,
  PLAN_ORDER_NAMES,
  TossApiError,
  TossPaymentResult,
} from "@/lib/toss";

// The subscribe flow, step by step: prepareSubscription records the chosen
// plan and hands back the customerKey for requestBillingAuth; Toss redirects
// to the callback, whose confirmSubscription exchanges the authKey for a
// billing key and charges (or schedules) the first period. The route handlers
// only translate these results into HTTP.

export type SignupResult<T extends object> =
  | ({ ok: true } & T)
  | { ok: false; status: number; message: string };

function fail(status: number, message: string) {
  return { ok: false as const, status, message };
}

const PREVIOUS_CHARGE_PENDING_MESSAGE =
  "이전 결제 결과를 확인하고 있습니다. 잠시 후 다시 시도해 주세요.";
const CHARGE_IN_PROGRESS_MESSAGE =
  "결제를 처리하고 있습니다. 잠시 후 다시 확인해 주세요.";
const SIGNUP_CHANGED_MESSAGE =
  "결제 준비 정보가 바뀌었습니다. 결제를 처음부터 다시 시작해 주세요.";

// Settles the subscription's orders whose outcome is still unknown. A new card
// must not start while one of them might yet turn out charged: the pending
// order's id and idempotency key belong to the old card and amount, and a late
// success has to land on the subscription first.
async function settlePendingCharges(subscriptionId: number): Promise<boolean> {
  const pending = await db
    .selectFrom("payments")
    .select("id")
    .where("subscription_id", "=", subscriptionId)
    .where("status", "=", "pending")
    .execute();
  for (const payment of pending) {
    try {
      await reconcilePayment(payment.id);
    } catch (error) {
      console.error(
        `Subscription prepare: reconciling payment ${payment.id} failed`,
        error,
      );
    }
  }
  const left = await db
    .selectFrom("payments")
    .select("id")
    .where("subscription_id", "=", subscriptionId)
    .where("status", "=", "pending")
    .executeTakeFirst();
  return left == null;
}

export async function prepareSubscription(opts: {
  userId: number;
  interval: BillingInterval;
  now?: Date;
}): Promise<SignupResult<{ customerKey: string }>> {
  const { userId, interval } = opts;
  const now = opts.now ?? new Date();

  const existingId = await db
    .selectFrom("subscriptions")
    .select("id")
    .where("user_id", "=", userId)
    .executeTakeFirst();
  if (existingId && !(await settlePendingCharges(existingId.id))) {
    return fail(409, PREVIOUS_CHARGE_PENDING_MESSAGE);
  }

  // Read after settling: a late charge may have just made it active again.
  const existing = await db
    .selectFrom("subscriptions")
    .select(["id", "status"])
    .where("user_id", "=", userId)
    .executeTakeFirst();
  const userRow = await db
    .selectFrom("users")
    .select(["supporter_comp", "supporter_until", "toss_customer_key"])
    .where("id", "=", userId)
    .executeTakeFirst();

  if (
    !canStartRecurringPurchase({
      supporterComp: !!userRow?.supporter_comp,
      supporterUntil: userRow?.supporter_until ?? null,
      subscriptionStatus: existing?.status ?? null,
    })
  ) {
    return fail(409, "이미 활성화되었거나 예약된 정기 결제가 있습니다.");
  }

  // A stable per-user customerKey. Toss asks for one nobody can guess; a
  // UUID also meets its character rules.
  let customerKey = userRow?.toss_customer_key ?? null;
  if (!customerKey) {
    customerKey = randomUUID();
    await db
      .updateTable("users")
      .set({ toss_customer_key: customerKey })
      .where("id", "=", userId)
      .execute();
  }

  const amount = PLAN_AMOUNTS[interval];

  if (!existing) {
    await db
      .insertInto("subscriptions")
      .values({
        user_id: userId,
        plan: "supporter",
        billing_interval: interval,
        amount,
        status: "incomplete",
        toss_customer_key: customerKey,
      })
      .execute();
    return { ok: true, customerKey };
  }

  // A new card is registered next, so the old key is done. The reset waits
  // for any charge in flight: a renewal still charging the old key would
  // otherwise land on a subscription whose key was just taken away.
  const staleLeaseBefore = new Date(
    now.getTime() - CHARGE_LEASE_MINUTES * 60 * 1000,
  );
  const reset = await db.transaction().execute(async (trx) => {
    const updated = await trx
      .updateTable("subscriptions")
      .set({
        plan: "supporter",
        billing_interval: interval,
        amount,
        status: "incomplete",
        toss_customer_key: customerKey,
        charging_started_at: null,
        updated_at: now,
      })
      .where("id", "=", existing.id)
      .where("status", "not in", ["active", "scheduled"])
      .where((eb) =>
        eb.or([
          eb("charging_started_at", "is", null),
          eb("charging_started_at", "<", staleLeaseBefore),
        ]),
      )
      .executeTakeFirst();
    if (Number(updated.numUpdatedRows ?? 0) === 0) {
      return { reset: false as const, billingKey: null };
    }
    return {
      reset: true as const,
      billingKey: await retireBillingKey(trx, { subscriptionId: existing.id }),
    };
  });
  await deleteRetiredBillingKey(reset.billingKey);
  if (!reset.reset) return fail(409, CHARGE_IN_PROGRESS_MESSAGE);

  return { ok: true, customerKey };
}

async function getOrCreateInitialChargeAttempt(opts: {
  subscriptionId: number;
  userId: number;
  amount: number;
}) {
  const prefix = `subscription_initial:${opts.subscriptionId}:`;

  const pending = await db
    .selectFrom("payments")
    .select(["id", "order_id", "status"])
    .where("subscription_id", "=", opts.subscriptionId)
    .where("attempt_key", "like", `${prefix}%`)
    .where("status", "=", "pending")
    .orderBy("id", "desc")
    .executeTakeFirst();

  if (pending) return pending;

  const countRow = await db
    .selectFrom("payments")
    .select(({ fn }) => fn.countAll().as("count"))
    .where("subscription_id", "=", opts.subscriptionId)
    .where("attempt_key", "like", `${prefix}%`)
    .executeTakeFirst();
  const attemptNumber = Number(countRow?.count ?? 0) + 1;

  try {
    return await db
      .insertInto("payments")
      .values({
        attempt_key: `${prefix}${attemptNumber}`,
        user_id: opts.userId,
        subscription_id: opts.subscriptionId,
        order_id: newOrderId(),
        amount: opts.amount,
        status: "pending",
      })
      .returning(["id", "order_id", "status"])
      .executeTakeFirstOrThrow();
  } catch (error) {
    const concurrent = await db
      .selectFrom("payments")
      .select(["id", "order_id", "status"])
      .where("subscription_id", "=", opts.subscriptionId)
      .where("attempt_key", "like", `${prefix}%`)
      .where("status", "=", "pending")
      .orderBy("id", "desc")
      .executeTakeFirst();
    if (concurrent) return concurrent;
    throw error;
  }
}

// Stores the key Toss just issued, but only on a signup still waiting for it.
// A cancel does not wait for the confirm's lease, so it may have landed while
// Toss was issuing; the key then belongs to nothing and is deleted at Toss.
async function storeIssuedBillingKey(
  subscriptionId: number,
  billingKey: string,
): Promise<boolean> {
  const { stored, discarded } = await db.transaction().execute(async (trx) => {
    const result = await trx
      .updateTable("subscriptions")
      .set({ toss_billing_key: billingKey, updated_at: new Date() })
      .where("id", "=", subscriptionId)
      .where("status", "=", "incomplete")
      .where("toss_billing_key", "is", null)
      .executeTakeFirst();
    if (Number(result.numUpdatedRows ?? 0) > 0) {
      return { stored: true, discarded: null };
    }
    return {
      stored: false,
      discarded: await discardIssuedBillingKey(trx, billingKey),
    };
  });
  await deleteRetiredBillingKey(discarded);
  return stored;
}

// The last look before the card is charged: the signup is still waiting and
// still holds the key this confirm is about to use.
async function stillConfirmable(subscriptionId: number, billingKey: string) {
  const current = await db
    .selectFrom("subscriptions")
    .select(["status", "toss_billing_key"])
    .where("id", "=", subscriptionId)
    .executeTakeFirst();
  return (
    current?.status === "incomplete" && current.toss_billing_key === billingKey
  );
}

// A first charge that failed for good ends this signup's use of its key.
async function failFirstCharge(opts: {
  subscriptionId: number;
  paymentId: number;
  set: Updateable<DB["payments"]>;
}) {
  const retired = await db.transaction().execute(async (trx) => {
    await trx
      .updateTable("payments")
      .set({ ...opts.set, status: "failed" })
      .where("id", "=", opts.paymentId)
      .where("status", "=", "pending")
      .execute();
    return retireUnusedSignupKey(trx, opts.subscriptionId, {
      ownsLease: true,
    });
  });
  await deleteRetiredBillingKey(retired);
}

type ConfirmOutcome = SignupResult<{
  message: string;
  scheduled?: boolean;
  startsAt?: string;
}>;

function alreadySettled(sub: {
  status: string;
  next_billing_at: Date | string | null;
}): ConfirmOutcome | null {
  if (sub.status === "active") {
    return { ok: true, message: "이미 결제 중입니다." };
  }
  if (sub.status === "scheduled" && sub.next_billing_at) {
    return {
      ok: true,
      scheduled: true,
      startsAt: new Date(sub.next_billing_at).toISOString(),
      message: "현재 결제 기간이 끝난 뒤 정기 결제가 시작됩니다.",
    };
  }
  return null;
}

export async function confirmSubscription(opts: {
  userId: number;
  authKey: string;
  customerKey: string;
}): Promise<ConfirmOutcome> {
  const { userId, authKey, customerKey } = opts;

  // The customerKey must belong to this user.
  const userRow = await db
    .selectFrom("users")
    .select([
      "email",
      "email_verified_at",
      "login_name",
      "supporter_until",
      "toss_customer_key",
    ])
    .where("id", "=", userId)
    .executeTakeFirst();
  if (
    !userRow?.toss_customer_key ||
    userRow.toss_customer_key !== customerKey
  ) {
    return fail(403, "유효하지 않은 요청입니다.");
  }

  const subscriptionFields = [
    "id",
    "billing_interval",
    "amount",
    "status",
    "toss_billing_key",
    "next_billing_at",
  ] as const;
  const sub = await db
    .selectFrom("subscriptions")
    .select(subscriptionFields)
    .where("user_id", "=", userId)
    .executeTakeFirst();
  if (!sub) return fail(400, "결제 정보를 찾을 수 없습니다.");
  // A doubled or reloaded callback reports what the first one did.
  const settled = alreadySettled(sub);
  if (settled) return settled;

  // Only the request holding the lease issues the key and charges.
  const leasedAt = await claimSubscriptionForConfirm(sub.id);
  if (!leasedAt) {
    const latest = await db
      .selectFrom("subscriptions")
      .select(subscriptionFields)
      .where("id", "=", sub.id)
      .executeTakeFirst();
    const latestSettled = latest && alreadySettled(latest);
    if (latestSettled) return latestSettled;
    return latest?.status === "incomplete"
      ? fail(409, CHARGE_IN_PROGRESS_MESSAGE)
      : fail(409, SIGNUP_CHANGED_MESSAGE);
  }

  try {
    return await confirmClaimedSubscription({
      sub,
      userId,
      userRow,
      authKey,
      customerKey,
    });
  } finally {
    await releaseSubscriptionLease(sub.id, leasedAt);
  }
}

// Runs with the subscription's charge lease held.
async function confirmClaimedSubscription(opts: {
  sub: {
    id: number;
    billing_interval: string;
    amount: number;
    toss_billing_key: string | null;
  };
  userId: number;
  userRow: {
    email: string | null;
    email_verified_at: Date | null;
    login_name: string;
    supporter_until: Date | null;
  };
  authKey: string;
  customerKey: string;
}): Promise<ConfirmOutcome> {
  const { sub, userId, userRow, authKey, customerKey } = opts;
  const interval = sub.billing_interval as BillingInterval;

  // Issue a reusable billing key from the one-time authKey.
  let billingKey = sub.toss_billing_key;
  if (!billingKey) {
    try {
      const issued = await issueBillingKey(authKey, customerKey);
      billingKey = issued.billingKey;
    } catch (err) {
      // A rejected authKey (expired, already used, card refused) is the
      // supporter's to retry from the start. Anything else may have issued a
      // key, which the same authKey's idempotency key will hand back.
      if (isDefinitiveTossFailure(err)) {
        return fail(402, err.message || "카드를 등록하지 못했습니다.");
      }
      return fail(
        503,
        "카드 등록 결과를 확인하고 있습니다. 잠시 후 다시 시도해 주세요.",
      );
    }
    if (!(await storeIssuedBillingKey(sub.id, billingKey))) {
      return fail(409, SIGNUP_CHANGED_MESSAGE);
    }
  }

  const now = new Date();
  const scheduledStart = scheduledRecurringStart(
    userRow.supporter_until ?? null,
    now,
  );
  if (scheduledStart) {
    if (!(await scheduleSubscriptionStart(sub.id, scheduledStart, now))) {
      return fail(409, SIGNUP_CHANGED_MESSAGE);
    }
    return {
      ok: true,
      scheduled: true,
      startsAt: scheduledStart.toISOString(),
      message: "현재 결제 기간이 끝난 뒤 정기 결제가 시작됩니다.",
    };
  }

  if (!(await stillConfirmable(sub.id, billingKey))) {
    return fail(409, SIGNUP_CHANGED_MESSAGE);
  }

  // Charge the first period.
  const attempt = await getOrCreateInitialChargeAttempt({
    subscriptionId: sub.id,
    userId,
    amount: sub.amount,
  });
  let payment: TossPaymentResult | undefined;
  try {
    try {
      const existingPayment = await getPaymentByOrderId(
        attempt.order_id,
        "billing",
      );
      if (existingPayment.status === "DONE") {
        payment = existingPayment;
      }
    } catch (err) {
      if (!(err instanceof TossApiError && err.status === 404)) {
        throw err;
      }
    }

    payment ??= await chargeBillingKey({
      billingKey,
      customerKey,
      amount: sub.amount,
      orderId: attempt.order_id,
      orderName: PLAN_ORDER_NAMES[interval],
      idempotencyKey: attempt.order_id,
    });
  } catch (err) {
    // A transport error is ambiguous: Toss may have completed the charge.
    // Keep the attempt pending, and the key with it, so the next callback or
    // the reconciler settles this orderId.
    if (!isDefinitiveTossFailure(err)) {
      return fail(
        503,
        "결제 결과를 확인하고 있습니다. 잠시 후 다시 시도해 주세요.",
      );
    }
    await failFirstCharge({
      subscriptionId: sub.id,
      paymentId: attempt.id,
      set: { raw: JSON.stringify({ error: err.message }) },
    });
    return fail(402, err.message);
  }

  if (payment.status !== "DONE") {
    await failFirstCharge({
      subscriptionId: sub.id,
      paymentId: attempt.id,
      set: {
        ...paymentProviderMetadata(payment, "billing"),
        toss_payment_key: payment.paymentKey,
        order_id: payment.orderId ?? attempt.order_id,
        amount: sub.amount,
        raw: JSON.stringify(payment),
      },
    });
    return fail(402, "결제가 완료되지 않았습니다.");
  }

  const period = await applySuccessfulCharge({
    subscriptionId: sub.id,
    userId,
    interval,
    amount: sub.amount,
    from: now,
    payment,
    paymentId: attempt.id,
  });

  if (userRow.email && userRow.email_verified_at) {
    try {
      await sendSupportThankYouEmail({
        email: userRow.email,
        loginName: userRow.login_name,
        kind: "recurring",
        amount: sub.amount,
        supporterUntil: period.periodEnd,
      });
    } catch (error) {
      console.error("Support thank-you email error:", error);
    }
  }

  return { ok: true, message: "결제가 시작되었습니다. 감사합니다!" };
}
