import { randomUUID } from "crypto";
import {
  LIVE_SUBSCRIPTION_STATUSES,
  type SubscriptionStatus,
} from "@/lib/payments/payment-states";
import type { Updateable } from "kysely";
import { db } from "@/lib/database";
import type { DB } from "@/lib/db";
import type { Executor } from "@/lib/entitlements";
import {
  chargeableKey,
  deleteRetiredBillingKey,
  discardIssuedBillingKey,
  retireBillingKey,
  storeIssuedKey,
  type StoredKey,
} from "@/lib/payments/billing-keys";
import {
  settleOneTimeOrders,
  settlePendingCharges,
} from "@/lib/payments/payment-reconciliation";
import { chargeDueSubscriptions } from "@/lib/payments/subscription-renewals";
import {
  kstDate,
  notePaymentEvent,
  recordPaymentEvent,
  won,
} from "@/lib/payments/payment-events";
import {
  canStartRecurringPurchase,
  scheduledRecurringStart,
} from "@/lib/payments/support-purchases";
import {
  applySuccessfulCharge,
  endPlan,
  plansOf,
  retireUnusedSignupKey,
  scheduleSubscriptionStart,
} from "@/lib/payments/subscriptions";
import { AccountBusyError, withAccountLock } from "@/lib/payments/account-lock";
import {
  BillingInterval,
  describeTossError,
  withNewOrderId,
  paymentProviderMetadata,
  PLAN_AMOUNTS,
  PLAN_ORDER_NAMES,
  TossApiError,
} from "@/lib/payments/toss";
import {
  chargeOrder,
  issueKey,
  type IssueOutcome,
} from "@/lib/payments/toss-gateway";

type IssuedKey = Extract<IssueOutcome, { kind: "issued" }>;

// The subscribe flow, step by step: prepareSubscription records a card
// registration (card_registrations) with the chosen interval and hands back
// the customerKey for requestBillingAuth; Toss redirects to the callback,
// whose confirmSubscription exchanges the authKey for a billing key, starts a
// new plan (a subscriptions row) holding it, and charges (or schedules) the
// first period. Changing the card of a running plan (prepareCardChange) goes
// through the same callback and confirm. The route handlers only translate
// these results into HTTP.
//
// Prepare changes nothing a supporter can see: a canceled or past_due plan
// stays as it is until the new card is actually registered, so closing the
// card window leaves the account where it was. Each step runs under the
// account lock (lib/payments/account-lock), so no renewal, refund or second callback
// runs on the account meanwhile.
//
// The callback carries its registration's id in its path, and confirm acts
// only on the account's latest registration. The key issue call's idempotency
// key comes from the authKey, and Toss replays its first answer for 15 days:
// without the id, an old callback reopened after a new prepare would get back
// the old card's key — retired, or waiting to be deleted at Toss — and use it.

export type SignupResult<T extends object> =
  | ({ ok: true } & T)
  | { ok: false; status: number; message: string };

function fail(status: number, message: string) {
  return { ok: false as const, status, message };
}

// A signup confirm may start from these: a first signup or one interrupted
// (incomplete), or a plan that ended (canceled, past_due) being started again.
const SIGNUP_FROM_STATUSES: SubscriptionStatus[] = [
  "incomplete",
  "canceled",
  "past_due",
];
// The plans still live — at most one per account. A new signup ends one of
// these first (an incomplete or past due one; an active or scheduled one
// cannot be signed up over).
const LIVE_STATUSES = LIVE_SUBSCRIPTION_STATUSES;

const PREVIOUS_CHARGE_PENDING_MESSAGE =
  "이전 결제 결과를 확인하고 있습니다. 잠시 후 다시 시도해 주세요.";
const CHARGE_IN_PROGRESS_MESSAGE =
  "결제를 처리하고 있습니다. 잠시 후 다시 확인해 주세요.";
// The subscriptions whose card can be changed in place. A past_due one
// registers its new card through prepareSubscription, which charges it.
const CARD_CHANGE_STATUSES: SubscriptionStatus[] = ["active", "scheduled"];
const NOT_CHANGEABLE_MESSAGE = "카드를 변경할 정기 결제가 없습니다.";

const SIGNUP_CHANGED_MESSAGE =
  "결제 준비 정보가 바뀌었습니다. 결제를 처음부터 다시 시작해 주세요.";
const STALE_REGISTRATION_MESSAGE =
  "더 이상 유효하지 않은 카드 등록입니다. 처음부터 다시 시작해 주세요.";

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

// The account's latest card registration: the only one whose callback may
// still act.
function latestRegistration(executor: Executor, userId: string) {
  return executor
    .selectFrom("card_registrations")
    .selectAll()
    .where("user_id", "=", userId)
    .orderBy("id", "desc")
    .limit(1)
    .executeTakeFirst();
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
}): Promise<SignupResult<PreparedRegistration>> {
  return underAccountLock(opts.userId, 409, () =>
    prepareSubscriptionLocked(opts),
  );
}

async function prepareSubscriptionLocked(opts: {
  userId: string;
  interval: BillingInterval;
}): Promise<SignupResult<PreparedRegistration>> {
  const { userId, interval } = opts;

  // A one-time order the buyer authenticated and left is confirmed by the
  // reconciler within minutes, and its approval switches off whatever plan
  // the account has — the one this signup starts included. Settle it first;
  // one still being confirmed at Toss makes the signup wait.
  if (!(await settleOneTimeOrders(userId))) {
    return fail(409, PREVIOUS_CHARGE_PENDING_MESSAGE);
  }
  if (!(await settlePendingCharges(userId))) {
    return fail(409, PREVIOUS_CHARGE_PENDING_MESSAGE);
  }

  // Read after settling: a late charge may have just made a plan active.
  const current = await plansOf(db, userId).select("status").executeTakeFirst();
  const userRow = await db
    .selectFrom("users")
    .select(["supporter_comp", "supporter_until", "toss_customer_key"])
    .where("id", "=", userId)
    .executeTakeFirst();
  if (
    !canStartRecurringPurchase({
      supporterComp: !!userRow?.supporter_comp,
      supporterUntil: userRow?.supporter_until ?? null,
      subscriptionStatus: current?.status ?? null,
    })
  ) {
    return fail(409, "이미 활성화되었거나 예약된 정기 결제가 있습니다.");
  }

  const customerKey = await customerKeyFor(
    userId,
    userRow?.toss_customer_key ?? null,
  );
  // Only the registration: no plan exists, and the current one (ended, past
  // due) stays as it is, until confirm has a key for the new one.
  const registration = await db
    .insertInto("card_registrations")
    .values({ user_id: userId, kind: "signup", billing_interval: interval })
    .returning("id")
    .executeTakeFirstOrThrow();
  return { ok: true, customerKey, registrationId: registration.id };
}

// Starts registering a new card for a plan that is running — active, or
// scheduled to start. Toss has no way to renew a billing key: it lasts as
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
  const plan = await plansOf(db, userId)
    .select(["id", "status", "billing_key_id"])
    .executeTakeFirst();
  if (
    !plan ||
    !CARD_CHANGE_STATUSES.includes(plan.status) ||
    !plan.billing_key_id
  ) {
    return fail(409, NOT_CHANGEABLE_MESSAGE);
  }
  // An order still unsettled was charged to the old key, and its retry must
  // not go to the new one under the same order number.
  if (!(await settlePendingCharges(userId))) {
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
  const registration = await db
    .insertInto("card_registrations")
    .values({ user_id: userId, kind: "card_change", subscription_id: plan.id })
    .returning("id")
    .executeTakeFirstOrThrow();
  return { ok: true, customerKey, registrationId: registration.id };
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

// Starts the plan this signup registration is for, with the key Toss just
// issued: the plan the account had, if still live (an earlier signup that
// never got charged, or one past due), ends and gives up its key, and a new
// incomplete plan holds the new key. Only while the registration is still the
// latest and the account may sign up; otherwise the key belongs to nothing
// and is deleted at Toss. Returns the new plan's id, or null.
async function adoptSignupKey(opts: {
  userId: string;
  registrationId: string;
  issued: IssuedKey;
  customerKey: string;
}): Promise<string | null> {
  const { planId, retired } = await db.transaction().execute(async (trx) => {
    const registration = await trx
      .selectFrom("card_registrations")
      .selectAll()
      .where("id", "=", opts.registrationId)
      .forUpdate()
      .executeTakeFirstOrThrow();
    const key = await storeIssuedKey(trx, {
      userId: opts.userId,
      customerKey: opts.customerKey,
      billingKey: opts.issued.billingKey,
      mid: opts.issued.mid,
      cardCompany: opts.issued.cardCompany,
      cardNumber: opts.issued.cardNumber,
    });
    const current = await plansOf(trx, opts.userId)
      .select(["id", "status"])
      .forUpdate()
      .executeTakeFirst();
    const latest = await latestRegistration(trx, opts.userId);
    if (
      registration.subscription_id != null ||
      latest?.id !== registration.id ||
      key.status !== "active" ||
      (current && !SIGNUP_FROM_STATUSES.includes(current.status))
    ) {
      return { planId: null, retired: await discardUnheldKey(trx, key) };
    }

    const now = new Date();
    const retired: Array<string | null> = [];
    if (current && LIVE_STATUSES.includes(current.status)) {
      const ended = await endPlan(trx, current.id, {
        summary: (from) => `새 정기 결제로 대체 (${from}에서)`,
      });
      retired.push(ended?.retiredKey ?? null);
    }
    const interval = registration.billing_interval as BillingInterval;
    const plan = await trx
      .insertInto("subscriptions")
      .values({
        user_id: opts.userId,
        plan: "supporter",
        billing_interval: interval,
        amount: PLAN_AMOUNTS[interval],
        status: "incomplete",
        billing_key_id: key.id,
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    await trx
      .updateTable("card_registrations")
      .set({
        subscription_id: plan.id,
        billing_key_id: key.id,
        completed_at: now,
      })
      .where("id", "=", registration.id)
      .execute();
    return { planId: plan.id, retired };
  });
  await deleteRetiredBillingKey(retired);
  return planId;
}

// A key just issued for a registration that can no longer use it is retired —
// unless a plan holds it already: Toss replays an authKey's key, and the
// plan that took it the first time keeps it.
async function discardUnheldKey(
  trx: Executor,
  key: StoredKey,
): Promise<string | null> {
  if (key.status !== "active") return null;
  const holder = await trx
    .selectFrom("subscriptions")
    .select("id")
    .where("billing_key_id", "=", key.id)
    .executeTakeFirst();
  return holder ? null : discardIssuedBillingKey(trx, key.id);
}

// The last look before the card is charged: the signup is still waiting and
// still holds the key this confirm is about to use.
async function stillConfirmable(subscriptionId: string, keyId: string) {
  const current = await db
    .selectFrom("subscriptions")
    .select(["status", "billing_key_id"])
    .where("id", "=", subscriptionId)
    .executeTakeFirst();
  return current?.status === "incomplete" && current.billing_key_id === keyId;
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
// same authKey's idempotency key hands back any key issued, on a retry. Either
// is a card_registration_failed event, so the operators hear of it.
async function issueFailure(
  issued: Exclude<IssueOutcome, { kind: "issued" }>,
  context: {
    userId: string;
    subscriptionId?: string | null;
    cardChange: boolean;
  },
) {
  await notePaymentEvent({
    kind: "card_registration_failed",
    userId: context.userId,
    subscriptionId: context.subscriptionId,
    summary: `${context.cardChange ? "카드 변경" : "정기 결제 가입"} 카드 등록 ${
      issued.kind === "refused" ? "거절" : "결과 불분명"
    }: ${describeTossError(issued.error)}`,
  });
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
  // From the callback's path.
  registrationId?: string | null;
}): Promise<ConfirmOutcome> {
  const { userId, authKey, customerKey } = opts;

  // The customerKey must belong to this user.
  const userRow = await db
    .selectFrom("users")
    .select("toss_customer_key")
    .where("id", "=", userId)
    .executeTakeFirst();
  if (
    !userRow?.toss_customer_key ||
    userRow.toss_customer_key !== customerKey
  ) {
    return fail(403, "유효하지 않은 요청입니다.");
  }

  return underAccountLock(userId, 503, async () => {
    // Only the latest registration may use its authKey: an older one's would
    // replay the key Toss issued for it back then.
    const registration = await latestRegistration(db, userId);
    if (!registration || registration.id !== opts.registrationId) {
      return fail(409, STALE_REGISTRATION_MESSAGE);
    }
    if (registration.kind === "card_change") {
      return confirmCardChange({
        userId,
        registrationId: registration.id,
        subscriptionId: registration.subscription_id!,
        authKey,
        customerKey,
      });
    }

    let planId = registration.subscription_id;
    if (planId) {
      // This registration already started its plan: a doubled or reloaded
      // callback reports what the first one did, and one retried after an
      // unresolved first charge charges again with the key it adopted.
      const plan = await db
        .selectFrom("subscriptions")
        .select(["status", "next_billing_at", "billing_key_id"])
        .where("id", "=", planId)
        .executeTakeFirstOrThrow();
      const settled = alreadySettled(plan);
      if (settled) return settled;
      if (plan.status !== "incomplete" || !plan.billing_key_id) {
        return fail(409, SIGNUP_CHANGED_MESSAGE);
      }
    } else {
      const current = await plansOf(db, userId)
        .select(["status", "next_billing_at"])
        .executeTakeFirst();
      const settled = current ? alreadySettled(current) : null;
      if (settled) return settled;
      const issued = await issueKey(authKey, customerKey);
      if (issued.kind !== "issued") {
        return issueFailure(issued, { userId, cardChange: false });
      }
      planId = await adoptSignupKey({
        userId,
        registrationId: registration.id,
        issued,
        customerKey,
      });
      if (!planId) return fail(409, SIGNUP_CHANGED_MESSAGE);
    }

    const plan = await db
      .selectFrom("subscriptions")
      .select(["id", "billing_interval", "amount", "billing_key_id"])
      .where("id", "=", planId)
      .executeTakeFirstOrThrow();
    // Paid time read now, under the lock: a refund or a one-time payment that
    // committed while this waited for it decides whether the first charge is
    // now or scheduled.
    const paidTime = await db
      .selectFrom("users")
      .select("supporter_until")
      .where("id", "=", userId)
      .executeTakeFirstOrThrow();
    return confirmAdoptedSignup({
      sub: { ...plan, billing_key_id: plan.billing_key_id! },
      userId,
      userRow: paidTime,
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
    billing_key_id: string;
  };
  userId: string;
  userRow: { supporter_until: Date | null };
}): Promise<ConfirmOutcome> {
  const { sub, userId, userRow } = opts;
  const interval = sub.billing_interval as BillingInterval;

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

  if (!(await stillConfirmable(sub.id, sub.billing_key_id))) {
    return fail(409, SIGNUP_CHANGED_MESSAGE);
  }
  const key = await chargeableKey(db, sub.id);
  if (!key) return fail(409, SIGNUP_CHANGED_MESSAGE);

  // Charge the first period.
  const attempt = await getOrCreateInitialChargeAttempt({
    subscriptionId: sub.id,
    userId,
    amount: sub.amount,
  });
  const outcome = await chargeOrder({
    billingKey: key.billingKey,
    customerKey: key.customerKey,
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

  // The thank-you goes with the grant (lib/payments/payment-jobs); a doubled callback,
  // or the reconciler settling this order first, finds it already owed.
  await applySuccessfulCharge({
    subscriptionId: sub.id,
    userId,
    interval,
    amount: sub.amount,
    from: now,
    payment,
    paymentId: attempt.id,
    notice: "thank_you",
  });

  return { ok: true, message: "결제가 시작되었습니다. 감사합니다!" };
}

// Issues the new card's key and swaps it in for the old one, under the
// account lock so no renewal is charging the old key meanwhile. A renewal that
// was failing gets its retry with the new card right away, rather than at the
// next run, and the answer says whether it went through.
async function confirmCardChange(opts: {
  userId: string;
  registrationId: string;
  subscriptionId: string;
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
  userId: string;
  registrationId: string;
  subscriptionId: string;
  authKey: string;
  customerKey: string;
}): Promise<ConfirmOutcome> {
  const { userId, registrationId, subscriptionId, authKey, customerKey } = opts;
  if (!(await settlePendingCharges(userId))) {
    return fail(409, PREVIOUS_CHARGE_PENDING_MESSAGE);
  }

  const issued = await issueKey(authKey, customerKey);
  if (issued.kind !== "issued") {
    return issueFailure(issued, { userId, subscriptionId, cardChange: true });
  }

  const changed = {
    ok: true as const,
    cardChanged: true,
    message: "결제 카드를 변경했습니다.",
  };
  const { result, retired } = await db.transaction().execute(async (trx) => {
    const registration = await trx
      .selectFrom("card_registrations")
      .select(["id", "completed_at"])
      .where("id", "=", registrationId)
      .forUpdate()
      .executeTakeFirstOrThrow();
    const current = await trx
      .selectFrom("subscriptions")
      .select(["status", "billing_key_id"])
      .where("id", "=", subscriptionId)
      .forUpdate()
      .executeTakeFirstOrThrow();
    const key = await storeIssuedKey(trx, {
      userId,
      customerKey,
      billingKey: issued.billingKey,
      mid: issued.mid,
      cardCompany: issued.cardCompany,
      cardNumber: issued.cardNumber,
    });
    // A doubled callback: the authKey's idempotency key handed back the key
    // this registration already put in place.
    if (current.billing_key_id === key.id) {
      return { result: changed, retired: null };
    }
    const latest = await latestRegistration(trx, userId);
    const stillOurs =
      CARD_CHANGE_STATUSES.includes(current.status) &&
      latest?.id === registration.id &&
      registration.completed_at == null &&
      key.status === "active";
    if (!stillOurs) {
      return {
        result: fail(409, SIGNUP_CHANGED_MESSAGE),
        retired: await discardUnheldKey(trx, key),
      };
    }
    const oldKey = await retireBillingKey(trx, { subscriptionId });
    await trx
      .updateTable("subscriptions")
      .set({ billing_key_id: key.id, updated_at: new Date() })
      .where("id", "=", subscriptionId)
      .execute();
    await trx
      .updateTable("card_registrations")
      .set({ billing_key_id: key.id, completed_at: new Date() })
      .where("id", "=", registrationId)
      .execute();
    await recordPaymentEvent(trx, {
      kind: "card_changed",
      userId,
      subscriptionId,
      summary: "정기 결제 카드 변경, 이전 빌링키는 폐기",
    });
    return { result: changed, retired: oldKey };
  });
  await deleteRetiredBillingKey(retired);
  return result;
}
