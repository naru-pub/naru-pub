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
import {
  reconcilePayment,
  settleOneTimeOrders,
} from "@/lib/payment-reconciliation";
import { chargeDueSubscriptions } from "@/lib/subscription-renewals";
import {
  kstDate,
  notePaymentEvent,
  recordPaymentEvent,
  won,
} from "@/lib/payment-events";
import {
  canStartRecurringPurchase,
  scheduledRecurringStart,
} from "@/lib/support-purchases";
import {
  applySuccessfulCharge,
  retireUnusedSignupKey,
  scheduleSubscriptionStart,
} from "@/lib/subscriptions";
import { AccountBusyError, withAccountLock } from "@/lib/account-lock";
import {
  BillingInterval,
  chargeBillingKey,
  describeTossError,
  getPaymentByOrderId,
  isDefinitiveTossFailure,
  issueBillingKey,
  withNewOrderId,
  paymentProviderMetadata,
  PLAN_AMOUNTS,
  PLAN_ORDER_NAMES,
  TossApiError,
  TossPaymentResult,
} from "@/lib/toss";
import { chargeOrder, issueKey, type IssueOutcome } from "@/lib/toss-gateway";

// The subscribe flow, step by step: prepareSubscription records a card
// registration and the chosen plan and hands back the customerKey for
// requestBillingAuth; Toss redirects to the callback, whose
// confirmSubscription exchanges the authKey for a billing key, switches the
// subscription to it and charges (or schedules) the first period. Changing
// the card of a running subscription (prepareCardChange) goes through the same
// callback and confirm. The route handlers only translate these results into
// HTTP.
//
// Prepare changes nothing a supporter can see: a canceled or past_due plan
// stays as it is until the new card is actually registered, so closing the
// card window leaves the account where it was. Each step runs under the
// account lock (lib/account-lock), so no renewal, refund or second callback
// runs on the account meanwhile.
//
// Each prepare starts a new card registration, whose id the callback carries
// in its path, and confirm acts only on the latest one. The key issue call's
// idempotency key comes from the authKey, and Toss replays its first answer
// for 15 days: without the id, an old callback reopened after a new prepare
// would get back the old card's key — retired, or still waiting to be deleted
// at Toss — and store it.

export type SignupResult<T extends object> =
  | ({ ok: true } & T)
  | { ok: false; status: number; message: string };

function fail(status: number, message: string) {
  return { ok: false as const, status, message };
}

// A signup confirm may start from these: a first signup or one interrupted
// (incomplete), or a plan that ended (canceled, past_due,
// switched_to_one_time) being started again.
const SIGNUP_FROM_STATUSES = [
  "incomplete",
  "canceled",
  "past_due",
  "switched_to_one_time",
];

const PREVIOUS_CHARGE_PENDING_MESSAGE =
  "이전 결제 결과를 확인하고 있습니다. 잠시 후 다시 시도해 주세요.";
const CHARGE_IN_PROGRESS_MESSAGE =
  "결제를 처리하고 있습니다. 잠시 후 다시 확인해 주세요.";
// The subscriptions whose card can be changed in place. A past_due one
// registers its new card through prepareSubscription, which charges it.
const CARD_CHANGE_STATUSES = ["active", "scheduled"];
const NOT_CHANGEABLE_MESSAGE = "카드를 변경할 정기 결제가 없습니다.";

const SIGNUP_CHANGED_MESSAGE =
  "결제 준비 정보가 바뀌었습니다. 결제를 처음부터 다시 시작해 주세요.";
const STALE_REGISTRATION_MESSAGE =
  "더 이상 유효하지 않은 카드 등록입니다. 처음부터 다시 시작해 주세요.";

// Settles the subscription's orders whose outcome is still unknown. A new card
// must not start while one of them might yet turn out charged: the pending
// order's id and idempotency key belong to the old card and amount, and a late
// success has to land on the subscription first. Callers hold the account
// lock, which reconciliation takes too.
export async function settlePendingCharges(
  subscriptionId: string,
): Promise<boolean> {
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

// A stable per-user customerKey. Toss asks for one nobody can guess; a UUID
// also meets its character rules.
async function customerKeyFor(
  userId: string,
  existing: string | null,
): Promise<string> {
  if (existing) return existing;
  const customerKey = randomUUID();
  await db
    .updateTable("users")
    .set({ toss_customer_key: customerKey })
    .where("id", "=", userId)
    .execute();
  return customerKey;
}

export type PreparedRegistration = {
  customerKey: string;
  registrationId: string;
};

// Runs a step of the flow under the account lock. A step that does not get
// it in time answers busy: 409 for a prepare the supporter can click again,
// 503 for a confirm, whose callback page retries on 503.
const LOCK_WAIT_MS = 5000;

async function underAccountLock<T extends object>(
  userId: string,
  busyStatus: number,
  fn: () => Promise<SignupResult<T>>,
): Promise<SignupResult<T>> {
  try {
    return await withAccountLock(userId, { waitMs: LOCK_WAIT_MS }, fn);
  } catch (error) {
    if (error instanceof AccountBusyError) {
      return fail(busyStatus, CHARGE_IN_PROGRESS_MESSAGE);
    }
    throw error;
  }
}

export async function prepareSubscription(opts: {
  userId: string;
  interval: BillingInterval;
  now?: Date;
}): Promise<SignupResult<PreparedRegistration>> {
  return underAccountLock(opts.userId, 409, () =>
    prepareSubscriptionLocked(opts),
  );
}

async function prepareSubscriptionLocked(opts: {
  userId: string;
  interval: BillingInterval;
  now?: Date;
}): Promise<SignupResult<PreparedRegistration>> {
  const { userId, interval } = opts;
  const now = opts.now ?? new Date();

  // A one-time order the buyer authenticated and left is confirmed by the
  // reconciler within minutes, and its approval switches off whatever plan
  // the account has — this one included. Settle it first; one still being
  // confirmed at Toss makes the signup wait.
  if (!(await settleOneTimeOrders(userId))) {
    return fail(409, PREVIOUS_CHARGE_PENDING_MESSAGE);
  }
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

  const customerKey = await customerKeyFor(
    userId,
    userRow?.toss_customer_key ?? null,
  );
  const amount = PLAN_AMOUNTS[interval];
  const registrationId = randomUUID();

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
        card_registration_id: registrationId,
        card_registration_kind: "signup",
        card_registration_interval: interval,
        plan_started_at: now,
      })
      .execute();
    return { ok: true, customerKey, registrationId };
  }

  // Only the registration: the plan's status, dates and current key stay
  // until confirm has a new key to put in their place.
  const started = await db
    .updateTable("subscriptions")
    .set({
      card_registration_id: registrationId,
      card_registration_kind: "signup",
      card_registration_interval: interval,
      updated_at: now,
    })
    .where("id", "=", existing.id)
    .where("status", "in", SIGNUP_FROM_STATUSES)
    .executeTakeFirst();
  if (Number(started.numUpdatedRows ?? 0) === 0) {
    return fail(409, "이미 활성화되었거나 예약된 정기 결제가 있습니다.");
  }
  return { ok: true, customerKey, registrationId };
}

// Starts registering a new card for a subscription that is running — active,
// or scheduled to start. Toss has no way to renew a billing key: it lasts as
// long as its card, and a reissued card needs a new key. Without this, a
// supporter whose card expired could only wait for renewals to fail into
// past_due before registering another.
export async function prepareCardChange(opts: {
  userId: string;
}): Promise<SignupResult<PreparedRegistration>> {
  return underAccountLock(opts.userId, 409, () =>
    prepareCardChangeLocked(opts.userId),
  );
}

async function prepareCardChangeLocked(
  userId: string,
): Promise<SignupResult<PreparedRegistration>> {
  const existing = await db
    .selectFrom("subscriptions")
    .select(["id", "status", "toss_billing_key"])
    .where("user_id", "=", userId)
    .executeTakeFirst();
  if (
    !existing ||
    !CARD_CHANGE_STATUSES.includes(existing.status) ||
    !existing.toss_billing_key
  ) {
    return fail(409, NOT_CHANGEABLE_MESSAGE);
  }
  // An order still unsettled was charged to the old key, and its retry must
  // not go to the new one under the same order number.
  if (!(await settlePendingCharges(existing.id))) {
    return fail(409, PREVIOUS_CHARGE_PENDING_MESSAGE);
  }

  const userRow = await db
    .selectFrom("users")
    .select("toss_customer_key")
    .where("id", "=", userId)
    .executeTakeFirst();
  const customerKey = await customerKeyFor(
    userId,
    userRow?.toss_customer_key ?? null,
  );
  const registrationId = randomUUID();
  const started = await db
    .updateTable("subscriptions")
    .set({
      card_registration_id: registrationId,
      card_registration_kind: "card_change",
      card_registration_interval: null,
      updated_at: new Date(),
    })
    .where("id", "=", existing.id)
    .where("status", "in", CARD_CHANGE_STATUSES)
    .executeTakeFirst();
  if (Number(started.numUpdatedRows ?? 0) === 0) {
    return fail(409, NOT_CHANGEABLE_MESSAGE);
  }
  return { ok: true, customerKey, registrationId };
}

async function getOrCreateInitialChargeAttempt(opts: {
  subscriptionId: string;
  userId: string;
  amount: number;
}) {
  const prefix = `subscription_initial:${opts.subscriptionId}:`;

  const pending = await db
    .selectFrom("payments")
    .select(["id", "order_id", "status", "charge_attempted_at"])
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
    return await withNewOrderId((orderId) =>
      db
        .insertInto("payments")
        .values({
          attempt_key: `${prefix}${attemptNumber}`,
          user_id: opts.userId,
          subscription_id: opts.subscriptionId,
          order_id: orderId,
          amount: opts.amount,
          status: "pending",
        })
        .returning(["id", "order_id", "status", "charge_attempted_at"])
        .executeTakeFirstOrThrow(),
    );
  } catch (error) {
    const concurrent = await db
      .selectFrom("payments")
      .select(["id", "order_id", "status", "charge_attempted_at"])
      .where("subscription_id", "=", opts.subscriptionId)
      .where("attempt_key", "like", `${prefix}%`)
      .where("status", "=", "pending")
      .orderBy("id", "desc")
      .executeTakeFirst();
    if (concurrent) return concurrent;
    throw error;
  }
}

// Switches the subscription to the key Toss just issued for this signup: the
// plan it was (canceled, past_due, an earlier signup's) gives way to an
// incomplete one with the new key and the chosen plan, and any old key is
// retired. Only while the registration is still this one; otherwise the key
// belongs to nothing and is deleted at Toss. A key the subscription already
// holds (Toss replays an authKey's key) is its own and is never discarded.
async function adoptSignupKey(opts: {
  subscriptionId: string;
  registrationId: string;
  billingKey: string;
  customerKey: string;
}): Promise<boolean> {
  const { adopted, retired } = await db.transaction().execute(async (trx) => {
    const current = await trx
      .selectFrom("subscriptions")
      .select([
        "status",
        "toss_billing_key",
        "card_registration_id",
        "card_registration_interval",
        "billing_interval",
      ])
      .where("id", "=", opts.subscriptionId)
      .forUpdate()
      .executeTakeFirstOrThrow();
    if (current.toss_billing_key === opts.billingKey) {
      return { adopted: current.status === "incomplete", retired: null };
    }
    if (
      current.card_registration_id !== opts.registrationId ||
      !SIGNUP_FROM_STATUSES.includes(current.status)
    ) {
      return {
        adopted: false,
        retired: await discardIssuedBillingKey(trx, opts.billingKey),
      };
    }
    const oldKey = await retireBillingKey(trx, {
      subscriptionId: opts.subscriptionId,
    });
    const interval = (current.card_registration_interval ??
      current.billing_interval) as BillingInterval;
    const now = new Date();
    await trx
      .updateTable("subscriptions")
      .set({
        status: "incomplete",
        plan: "supporter",
        billing_interval: interval,
        amount: PLAN_AMOUNTS[interval],
        toss_billing_key: opts.billingKey,
        toss_customer_key: opts.customerKey,
        card_registration_interval: null,
        plan_started_at: now,
        next_billing_at: null,
        failed_charge_count: 0,
        canceled_at: null,
        updated_at: now,
      })
      .where("id", "=", opts.subscriptionId)
      .execute();
    return { adopted: true, retired: oldKey };
  });
  await deleteRetiredBillingKey(retired);
  return adopted;
}

// The last look before the card is charged: the signup is still waiting and
// still holds the key this confirm is about to use.
async function stillConfirmable(subscriptionId: string, billingKey: string) {
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
  userId: string;
  subscriptionId: string;
  paymentId: string;
  amount: number;
  reason: string;
  set: Updateable<DB["payments"]>;
}) {
  const retired = await db.transaction().execute(async (trx) => {
    await trx
      .updateTable("payments")
      .set({ ...opts.set, status: "failed" })
      .where("id", "=", opts.paymentId)
      .where("status", "=", "pending")
      .execute();
    await recordPaymentEvent(trx, {
      kind: "charge_failed",
      userId: opts.userId,
      paymentId: opts.paymentId,
      subscriptionId: opts.subscriptionId,
      summary: `정기 결제 첫 결제 실패 ${won(opts.amount)}: ${opts.reason} · 등록한 카드는 폐기`,
    });
    return retireUnusedSignupKey(trx, opts.subscriptionId);
  });
  await deleteRetiredBillingKey(retired);
}

// A key Toss would not issue: refused on its merits (expired or used authKey,
// card refused) — the supporter starts over — or not known, in which case the
// same authKey's idempotency key hands back any key issued, on a retry.
function issueFailure(issued: Exclude<IssueOutcome, { kind: "issued" }>) {
  return issued.kind === "refused"
    ? fail(402, issued.error.message || "카드를 등록하지 못했습니다.")
    : fail(
        503,
        "카드 등록 결과를 확인하고 있습니다. 잠시 후 다시 시도해 주세요.",
      );
}

type ConfirmOutcome = SignupResult<{
  message: string;
  scheduled?: boolean;
  startsAt?: string;
  cardChanged?: boolean;
  // A card change whose overdue renewal is still not paid on the new card.
  renewalStillDue?: boolean;
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
  userId: string;
  authKey: string;
  customerKey: string;
  // From the callback's path. Absent only on a callback for a registration
  // prepared before registrations had ids.
  registrationId?: string | null;
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

  return underAccountLock(userId, 503, async () => {
    const sub = await db
      .selectFrom("subscriptions")
      .select([
        "id",
        "status",
        "toss_billing_key",
        "next_billing_at",
        "card_registration_id",
        "card_registration_kind",
        "card_registration_interval",
      ])
      .where("user_id", "=", userId)
      .executeTakeFirst();
    if (!sub) return fail(400, "결제 정보를 찾을 수 없습니다.");
    // Only the latest registration may use its authKey: an older one's would
    // replay the key Toss issued for it back then.
    if ((opts.registrationId ?? null) !== sub.card_registration_id) {
      return fail(409, STALE_REGISTRATION_MESSAGE);
    }
    if (sub.card_registration_kind === "card_change") {
      return confirmCardChange({
        subscriptionId: sub.id,
        registrationId: sub.card_registration_id!,
        authKey,
        customerKey,
      });
    }
    // A doubled or reloaded callback reports what the first one did.
    const settled = alreadySettled(sub);
    if (settled) return settled;
    if (!SIGNUP_FROM_STATUSES.includes(sub.status)) {
      return fail(409, SIGNUP_CHANGED_MESSAGE);
    }

    // The key this registration already adopted — a callback retried after
    // an unresolved first charge — or a new one from the authKey.
    if (sub.card_registration_interval != null || !sub.toss_billing_key) {
      const issued = await issueKey(authKey, customerKey);
      if (issued.kind !== "issued") return issueFailure(issued);
      const billingKey = issued.billingKey;
      if (
        !(await adoptSignupKey({
          subscriptionId: sub.id,
          registrationId: sub.card_registration_id!,
          billingKey,
          customerKey,
        }))
      ) {
        return fail(409, SIGNUP_CHANGED_MESSAGE);
      }
    }

    const adopted = await db
      .selectFrom("subscriptions")
      .select(["id", "billing_interval", "amount", "toss_billing_key"])
      .where("id", "=", sub.id)
      .executeTakeFirstOrThrow();
    return confirmAdoptedSignup({
      sub: { ...adopted, toss_billing_key: adopted.toss_billing_key! },
      userId,
      userRow,
      customerKey,
    });
  });
}

// Schedules or charges the first period of a signup that holds its key.
// Runs under the account lock.
async function confirmAdoptedSignup(opts: {
  sub: {
    id: string;
    billing_interval: string;
    amount: number;
    toss_billing_key: string;
  };
  userId: string;
  userRow: {
    email: string | null;
    email_verified_at: Date | null;
    login_name: string;
    supporter_until: Date | null;
  };
  customerKey: string;
}): Promise<ConfirmOutcome> {
  const { sub, userId, userRow, customerKey } = opts;
  const interval = sub.billing_interval as BillingInterval;
  const billingKey = sub.toss_billing_key;

  const now = new Date();
  const scheduledStart = scheduledRecurringStart(
    userRow.supporter_until ?? null,
    now,
  );
  if (scheduledStart) {
    if (!(await scheduleSubscriptionStart(sub.id, scheduledStart, now))) {
      return fail(409, SIGNUP_CHANGED_MESSAGE);
    }
    await notePaymentEvent({
      kind: "subscription_scheduled",
      userId,
      subscriptionId: sub.id,
      summary: `정기 결제 ${won(sub.amount)} (${interval === "month" ? "월간" : "연간"}) 등록, 남은 기간 뒤 ${kstDate(scheduledStart)}에 첫 결제`,
    });
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
  const outcome = await chargeOrder({
    billingKey,
    customerKey,
    amount: sub.amount,
    orderId: attempt.order_id,
    orderName: PLAN_ORDER_NAMES[interval],
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
    return fail(
      503,
      "결제 결과를 확인하고 있습니다. 잠시 후 다시 시도해 주세요.",
    );
  }
  if (outcome.kind === "declined") {
    await failFirstCharge({
      userId,
      subscriptionId: sub.id,
      paymentId: attempt.id,
      amount: sub.amount,
      reason: outcome.payment
        ? `Toss 상태 ${outcome.payment.status}`
        : describeTossError(outcome.error),
      set: outcome.payment
        ? {
            ...paymentProviderMetadata(outcome.payment, "billing"),
            toss_payment_key: outcome.payment.paymentKey,
            raw: JSON.stringify(outcome.payment),
          }
        : { raw: JSON.stringify({ error: describeTossError(outcome.error) }) },
    });
    return fail(
      402,
      outcome.error instanceof TossApiError && outcome.error.message
        ? outcome.error.message
        : "결제가 완료되지 않았습니다.",
    );
  }
  const payment = outcome.payment;

  const period = await applySuccessfulCharge({
    subscriptionId: sub.id,
    userId,
    interval,
    amount: sub.amount,
    from: now,
    payment,
    paymentId: attempt.id,
  });

  // A doubled callback, or the reconciler settling this order first (it sends
  // its own receipt), finds the period already granted.
  if (period.granted && userRow.email && userRow.email_verified_at) {
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

// Issues the new card's key and swaps it in for the old one, under the
// account lock so no renewal is charging the old key meanwhile. A renewal that
// was failing gets its retry with the new card right away, rather than at the
// next run, and the answer says whether it went through.
async function confirmCardChange(opts: {
  subscriptionId: string;
  registrationId: string;
  authKey: string;
  customerKey: string;
}): Promise<ConfirmOutcome> {
  const swapped = await swapCard(opts);
  if (!swapped.ok) return swapped;

  const isDue = () =>
    db
      .selectFrom("subscriptions")
      .select("id")
      .where("id", "=", opts.subscriptionId)
      .where("status", "in", CARD_CHANGE_STATUSES)
      .where("next_billing_at", "<=", new Date())
      .executeTakeFirst();
  if (!(await isDue())) return swapped;
  try {
    await chargeDueSubscriptions(new Date(), {
      subscriptionIds: [opts.subscriptionId],
      newCard: true,
    });
  } catch (error) {
    // The next run retries it; the card itself is already changed.
    console.error(
      `Card change: charging subscription ${opts.subscriptionId} failed`,
      error,
    );
  }
  if (await isDue()) {
    return {
      ...swapped,
      renewalStillDue: true,
      message:
        "결제 카드를 변경했지만 밀린 정기 결제는 아직 완료되지 않았습니다. 결제 결과를 확인해 다시 시도합니다.",
    };
  }
  return swapped;
}

async function swapCard(opts: {
  subscriptionId: string;
  registrationId: string;
  authKey: string;
  customerKey: string;
}): Promise<ConfirmOutcome> {
  const { subscriptionId, registrationId, authKey, customerKey } = opts;
  if (!(await settlePendingCharges(subscriptionId))) {
    return fail(409, PREVIOUS_CHARGE_PENDING_MESSAGE);
  }

  const issued = await issueKey(authKey, customerKey);
  if (issued.kind !== "issued") return issueFailure(issued);
  const billingKey = issued.billingKey;

  const changed = {
    ok: true as const,
    cardChanged: true,
    message: "결제 카드를 변경했습니다.",
  };
  const { result, retired } = await db.transaction().execute(async (trx) => {
    const current = await trx
      .selectFrom("subscriptions")
      .select(["user_id", "status", "toss_billing_key", "card_registration_id"])
      .where("id", "=", subscriptionId)
      .forUpdate()
      .executeTakeFirstOrThrow();
    // A doubled callback: the authKey's idempotency key handed back the key
    // this registration already stored.
    if (current.toss_billing_key === billingKey) {
      return { result: changed, retired: null };
    }
    const stillOurs =
      CARD_CHANGE_STATUSES.includes(current.status) &&
      current.card_registration_id === registrationId;
    if (!stillOurs) {
      return {
        result: fail(409, SIGNUP_CHANGED_MESSAGE),
        retired: await discardIssuedBillingKey(trx, billingKey),
      };
    }
    const oldKey = await retireBillingKey(trx, { subscriptionId });
    await trx
      .updateTable("subscriptions")
      .set({
        toss_billing_key: billingKey,
        toss_customer_key: customerKey,
        updated_at: new Date(),
      })
      .where("id", "=", subscriptionId)
      .execute();
    await recordPaymentEvent(trx, {
      kind: "card_changed",
      userId: current.user_id,
      subscriptionId,
      summary: "정기 결제 카드 변경, 이전 빌링키는 폐기",
    });
    return { result: changed, retired: oldKey };
  });
  await deleteRetiredBillingKey(retired);
  return result;
}
