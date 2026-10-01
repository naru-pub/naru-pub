/** @jest-environment node */
import {
  afterAll,
  beforeEach,
  describe,
  expect,
  jest,
  test,
} from "@jest/globals";
import { createHmac, randomUUID } from "crypto";
import type { TossPaymentResult } from "@/lib/toss";

jest.mock("@/lib/toss", () => {
  const actual = jest.requireActual<typeof import("@/lib/toss")>("@/lib/toss");
  return {
    ...actual,
    cancelPayment: jest.fn(),
    chargeBillingKey: jest.fn(),
    confirmPayment: jest.fn(),
    deleteBillingKey: jest.fn(),
    getPaymentByOrderId: jest.fn(),
    issueBillingKey: jest.fn(),
  };
});
jest.mock("@/lib/email", () => ({
  sendSubscriptionPaymentGraceEmail: jest.fn(async () => {}),
  sendSubscriptionPastDueEmail: jest.fn(async () => {}),
  sendSupportThankYouEmail: jest.fn(async () => {}),
  sendRecurringChargeReceiptEmail: jest.fn(async () => {}),
  sendPaymentEventDigestEmail: jest.fn(async () => {}),
  sendPaymentCanceledEmail: jest.fn(async () => {}),
  sendSubscriptionCanceledEmail: jest.fn(async () => {}),
}));

jest.mock("@/lib/auth", () => ({ validateRequest: jest.fn() }));

// Required after the mocks: this transform does not hoist jest.mock above
// imports.
const { sql } = require("kysely") as typeof import("kysely");
const { db } = require("@/lib/database") as typeof import("@/lib/database");
const toss = require("@/lib/toss") as jest.Mocked<typeof import("@/lib/toss")>;
const email = require("@/lib/email") as jest.Mocked<
  typeof import("@/lib/email")
>;
const {
  addPaymentGrace,
  applyOneTimePayment,
  applySuccessfulCharge,
  claimSubscriptionForConfirm,
  MAX_PAYMENT_RETRY_ATTEMPTS,
  releaseSubscriptionLease,
  scheduleSubscriptionStart,
} = require("@/lib/subscriptions") as typeof import("@/lib/subscriptions");
const { chargeDueSubscriptions } =
  require("@/lib/subscription-renewals") as typeof import("@/lib/subscription-renewals");
const { reconcilePayment, recoverOrphanedCharge } =
  require("@/lib/payment-reconciliation") as typeof import("@/lib/payment-reconciliation");
const { refundPayment } =
  require("@/lib/refunds") as typeof import("@/lib/refunds");
const { syncPaymentRefunds } =
  require("@/lib/refund-sync") as typeof import("@/lib/refund-sync");
const { runLabAction } =
  require("@/lib/billing-lab") as typeof import("@/lib/billing-lab");
const { sendPaymentEventDigest } =
  require("@/lib/payment-events") as typeof import("@/lib/payment-events");
const { PAYMENT_FILTERS, supporterCondition } =
  require("@/app/(main)/admin/_components/metrics") as typeof import("@/app/(main)/admin/_components/metrics");
const { getUserEntitlement } =
  require("@/lib/entitlements") as typeof import("@/lib/entitlements");
const { deleteRetiredBillingKeys, retireBillingKey } =
  require("@/lib/billing-keys") as typeof import("@/lib/billing-keys");
const { deleteUserRow, settleChargesBeforeDeletion } =
  require("@/lib/account-deletion") as typeof import("@/lib/account-deletion");
const { POST: oneTimePrepareRoute } =
  require("@/app/(main)/api/account/donation/one-time/prepare/route") as typeof import("@/app/(main)/api/account/donation/one-time/prepare/route");
const { POST: oneTimeConfirmRoute } =
  require("@/app/(main)/api/account/donation/one-time/confirm/route") as typeof import("@/app/(main)/api/account/donation/one-time/confirm/route");
const { confirmSubscription, prepareCardChange, prepareSubscription } =
  require("@/lib/subscription-signup") as typeof import("@/lib/subscription-signup");
const { NextRequest } = require("next/server") as typeof import("next/server");
const auth = require("@/lib/auth") as jest.Mocked<typeof import("@/lib/auth")>;
const { POST: cancelSubscriptionRoute } =
  require("@/app/(main)/api/account/subscription/cancel/route") as typeof import("@/app/(main)/api/account/subscription/cancel/route");
const { POST: tossWebhook } =
  require("@/app/(main)/api/webhooks/toss/route") as typeof import("@/app/(main)/api/webhooks/toss/route");

// Runs against a disposable, migrated database (scripts/test-payments-db.sh),
// never the developer's own.
const integration =
  process.env.NARU_PAYMENTS_DB_TEST === "1" ? describe : describe.skip;

const DAY = 24 * 60 * 60 * 1000;

let userCounter = 0;

function tossPayment(
  orderId: string,
  totalAmount: number,
  extra: Partial<TossPaymentResult> = {},
): TossPaymentResult {
  return {
    paymentKey: `pk-${orderId}`,
    orderId,
    status: "DONE",
    totalAmount,
    ...extra,
  };
}

async function makeUser(supporterUntil: Date | null = null) {
  userCounter += 1;
  const row = await db
    .insertInto("users")
    .values({
      login_name: `payer${userCounter}`,
      password_hash: "x",
      email: `payer${userCounter}@example.com`,
      email_verified_at: new Date(),
      supporter_until: supporterUntil,
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  return row.id;
}

async function makeSubscription(
  userId: string,
  values: {
    status: string;
    billingKey?: string | null;
    currentPeriodEnd?: Date | null;
    nextBillingAt?: Date | null;
    failedChargeCount?: number;
    renewalNoticeSentAt?: Date | null;
    graceNoticeSentAt?: Date | null;
    planStartedAt?: Date;
  },
) {
  const row = await db
    .insertInto("subscriptions")
    .values({
      user_id: userId,
      plan: "supporter",
      billing_interval: "month",
      amount: 1000,
      status: values.status,
      toss_customer_key: randomUUID(),
      toss_billing_key:
        values.billingKey === undefined
          ? `billing-${userId}`
          : values.billingKey,
      current_period_end: values.currentPeriodEnd ?? null,
      next_billing_at: values.nextBillingAt ?? null,
      failed_charge_count: values.failedChargeCount ?? 0,
      renewal_notice_sent_at: values.renewalNoticeSentAt ?? null,
      payment_grace_notice_sent_at: values.graceNoticeSentAt ?? null,
      // A plan running long before anything a test does to it, unless the
      // test says when it began (a refund ends only a plan older than it).
      plan_started_at: values.planStartedAt ?? new Date(Date.now() - 365 * DAY),
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  return row.id;
}

async function makePendingPayment(opts: {
  userId: string;
  subscriptionId: string | null;
  attemptKey: string;
  orderId: string;
  amount: number;
}) {
  const row = await db
    .insertInto("payments")
    .values({
      user_id: opts.userId,
      subscription_id: opts.subscriptionId,
      attempt_key: opts.attemptKey,
      order_id: opts.orderId,
      amount: opts.amount,
      status: "pending",
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  return row.id;
}

function subscription(id: string) {
  return db
    .selectFrom("subscriptions")
    .selectAll()
    .where("id", "=", id)
    .executeTakeFirstOrThrow();
}

async function supporterUntil(userId: string) {
  const row = await db
    .selectFrom("users")
    .select("supporter_until")
    .where("id", "=", userId)
    .executeTakeFirstOrThrow();
  return row.supporter_until ? new Date(row.supporter_until) : null;
}

integration("payments against the database", () => {
  beforeEach(async () => {
    await sql`truncate users, subscriptions, payments, retired_billing_keys, payment_events, toss_webhook_deliveries restart identity cascade`.execute(
      db,
    );
    jest.clearAllMocks();
    toss.chargeBillingKey.mockReset();
    toss.cancelPayment.mockReset();
    toss.confirmPayment.mockReset();
    toss.deleteBillingKey.mockReset();
    toss.deleteBillingKey.mockResolvedValue(undefined);
    toss.issueBillingKey.mockReset();
    toss.getPaymentByOrderId.mockRejectedValue(
      new toss.TossApiError("not found", 404),
    );
  });

  afterAll(async () => {
    await db.destroy();
  });

  // withNewOrderId recognizes a taken order id by the constraint Postgres
  // names, so check that name against the real schema.
  test("draws another order id when one is taken", async () => {
    const userId = await makeUser();
    await makePendingPayment({
      userId,
      subscriptionId: null,
      attemptKey: "taken",
      orderId: "2026-10-01-0000-0001",
      amount: 1000,
    });
    const tried: string[] = [];
    const orderId = await toss.withNewOrderId(async (id) => {
      const orderId = tried.length === 0 ? "2026-10-01-0000-0001" : id;
      tried.push(orderId);
      await makePendingPayment({
        userId,
        subscriptionId: null,
        attemptKey: "fresh",
        orderId,
        amount: 1000,
      });
      return orderId;
    });
    expect(tried).toHaveLength(2);
    expect(orderId).not.toBe("2026-10-01-0000-0001");
  });

  describe("granting a charged period", () => {
    // A one-time year stacked past current_period_end must survive a renewal
    // that was computed from the subscription's own period.
    test("a renewal never shortens prepaid time", async () => {
      const periodEnd = new Date(Date.now() + 2 * DAY);
      const prepaidUntil = new Date(Date.now() + 300 * DAY);
      const userId = await makeUser(prepaidUntil);
      const subId = await makeSubscription(userId, {
        status: "active",
        currentPeriodEnd: periodEnd,
      });

      const { periodStart, periodEnd: granted } = await applySuccessfulCharge({
        subscriptionId: subId,
        userId,
        interval: "month",
        amount: 1000,
        from: periodEnd,
        payment: tossPayment("renewal-1", 1000),
      });

      expect(periodStart).toEqual(prepaidUntil);
      expect(granted > prepaidUntil).toBe(true);
      expect(await supporterUntil(userId)).toEqual(granted);
    });

    test("a charge that lands after a cancel keeps the subscription canceled", async () => {
      const userId = await makeUser(new Date(Date.now() - DAY));
      const subId = await makeSubscription(userId, {
        status: "canceled",
        billingKey: null,
      });

      await applySuccessfulCharge({
        subscriptionId: subId,
        userId,
        interval: "month",
        amount: 1000,
        from: new Date(),
        payment: tossPayment("late-1", 1000),
      });

      const sub = await subscription(subId);
      expect(sub.status).toBe("canceled");
      expect(sub.next_billing_at).toBeNull();
      expect(sub.toss_billing_key).toBeNull();
      // The money was taken, so the period it paid for is still granted.
      expect((await supporterUntil(userId))! > new Date()).toBe(true);
    });

    test("a one-time purchase stops a scheduled subscription", async () => {
      const paidThrough = new Date(Date.now() + 10 * DAY);
      const userId = await makeUser(paidThrough);
      const subId = await makeSubscription(userId, {
        status: "scheduled",
        currentPeriodEnd: paidThrough,
        nextBillingAt: paidThrough,
      });

      const { periodStart } = await applyOneTimePayment({
        userId,
        amount: 12000,
        years: 1,
        payment: tossPayment("one-time-1", 12000),
      });

      expect(periodStart).toEqual(paidThrough);
      const sub = await subscription(subId);
      expect(sub.status).toBe("switched_to_one_time");
      expect(sub.toss_billing_key).toBeNull();
      expect(sub.next_billing_at).toBeNull();

      // And the renewal cron has nothing left to charge.
      await chargeDueSubscriptions(new Date(paidThrough.getTime() + DAY));
      expect(toss.chargeBillingKey).not.toHaveBeenCalled();
    });
  });

  describe("the subscribe confirm lease", () => {
    test("only one confirm at a time may charge", async () => {
      const userId = await makeUser();
      const subId = await makeSubscription(userId, { status: "incomplete" });

      const first = await claimSubscriptionForConfirm(subId);
      expect(first).not.toBeNull();
      expect(await claimSubscriptionForConfirm(subId)).toBeNull();

      await releaseSubscriptionLease(subId, first!);
      expect(await claimSubscriptionForConfirm(subId)).not.toBeNull();
    });

    test("an abandoned lease expires", async () => {
      const userId = await makeUser();
      const subId = await makeSubscription(userId, { status: "incomplete" });

      expect(
        await claimSubscriptionForConfirm(subId, new Date(Date.now() - DAY)),
      ).not.toBeNull();
      expect(await claimSubscriptionForConfirm(subId)).not.toBeNull();
    });

    test("an active subscription is not charged again", async () => {
      const userId = await makeUser();
      const subId = await makeSubscription(userId, { status: "active" });

      expect(await claimSubscriptionForConfirm(subId)).toBeNull();
    });

    test("scheduling a first charge resets notices left from an earlier subscription", async () => {
      const startsAt = new Date(Date.now() + 2 * DAY);
      const userId = await makeUser(startsAt);
      const subId = await makeSubscription(userId, {
        status: "incomplete",
        renewalNoticeSentAt: new Date(Date.now() - 60 * DAY),
        graceNoticeSentAt: new Date(Date.now() - 60 * DAY),
      });

      await scheduleSubscriptionStart(subId, startsAt);

      const sub = await subscription(subId);
      expect(sub.status).toBe("scheduled");
      expect(sub.next_billing_at).toEqual(startsAt);
      expect(sub.renewal_notice_sent_at).toBeNull();
      expect(sub.payment_grace_notice_sent_at).toBeNull();
    });
  });

  describe("the renewal cron", () => {
    test("renews a due subscription", async () => {
      const periodEnd = new Date(Date.now() - 60 * 1000);
      const userId = await makeUser(periodEnd);
      const subId = await makeSubscription(userId, {
        status: "active",
        currentPeriodEnd: periodEnd,
        nextBillingAt: periodEnd,
      });
      toss.chargeBillingKey.mockImplementation(async (params) =>
        tossPayment(params.orderId, params.amount),
      );

      await chargeDueSubscriptions();

      const sub = await subscription(subId);
      expect(sub.status).toBe("active");
      expect(sub.charging_started_at).toBeNull();
      expect(new Date(sub.next_billing_at!) > new Date()).toBe(true);
      expect(await supporterUntil(userId)).toEqual(
        new Date(sub.current_period_end!),
      );
      expect(email.sendRecurringChargeReceiptEmail).toHaveBeenCalledTimes(1);
      expect(email.sendRecurringChargeReceiptEmail).toHaveBeenCalledWith(
        expect.objectContaining({
          email: expect.stringMatching(/@example\.com$/),
          amount: 1000,
          periodEnd: new Date(sub.current_period_end!),
          nextBillingAt: new Date(sub.next_billing_at!),
        }),
      );
    });

    test("a cancel during a failed charge is not overwritten", async () => {
      const periodEnd = new Date(Date.now() - 60 * 1000);
      const userId = await makeUser(periodEnd);
      const subId = await makeSubscription(userId, {
        status: "active",
        currentPeriodEnd: periodEnd,
        nextBillingAt: periodEnd,
      });
      toss.chargeBillingKey.mockImplementation(async () => {
        await db
          .updateTable("subscriptions")
          .set({
            status: "canceled",
            toss_billing_key: null,
            next_billing_at: null,
          })
          .where("id", "=", subId)
          .execute();
        throw new toss.TossApiError("card declined", 400);
      });

      await chargeDueSubscriptions();

      const sub = await subscription(subId);
      expect(sub.status).toBe("canceled");
      expect(sub.charging_started_at).toBeNull();
    });

    test("a cancel during a successful charge is not revived", async () => {
      const periodEnd = new Date(Date.now() - 60 * 1000);
      const userId = await makeUser(periodEnd);
      const subId = await makeSubscription(userId, {
        status: "active",
        currentPeriodEnd: periodEnd,
        nextBillingAt: periodEnd,
      });
      toss.chargeBillingKey.mockImplementation(async (params) => {
        await db
          .updateTable("subscriptions")
          .set({
            status: "canceled",
            toss_billing_key: null,
            next_billing_at: null,
          })
          .where("id", "=", subId)
          .execute();
        return tossPayment(params.orderId, params.amount);
      });

      await chargeDueSubscriptions();

      const sub = await subscription(subId);
      expect(sub.status).toBe("canceled");
      expect(sub.next_billing_at).toBeNull();
    });

    test("a failed scheduled first charge stays scheduled", async () => {
      const startsAt = new Date(Date.now() - 60 * 1000);
      const userId = await makeUser(startsAt);
      const subId = await makeSubscription(userId, {
        status: "scheduled",
        currentPeriodEnd: startsAt,
        nextBillingAt: startsAt,
      });
      toss.chargeBillingKey.mockRejectedValue(
        new toss.TossApiError("card declined", 400),
      );

      await chargeDueSubscriptions();

      const sub = await subscription(subId);
      expect(sub.status).toBe("scheduled");
      expect(sub.failed_charge_count).toBe(1);
      expect(email.sendSubscriptionPaymentGraceEmail).toHaveBeenCalledTimes(1);
    });

    test("no grace notice goes out once the grace period is over", async () => {
      const periodEnd = new Date(Date.now() - 10 * DAY);
      const userId = await makeUser(periodEnd);
      const subId = await makeSubscription(userId, {
        status: "active",
        currentPeriodEnd: periodEnd,
        nextBillingAt: periodEnd,
      });
      toss.chargeBillingKey.mockRejectedValue(
        new toss.TossApiError("card declined", 400),
      );

      await chargeDueSubscriptions();

      expect((await subscription(subId)).status).toBe("past_due");
      expect(email.sendSubscriptionPaymentGraceEmail).not.toHaveBeenCalled();
    });
  });

  describe("reconciliation", () => {
    // An ambiguous renewal resolved after the user switched to a one-time
    // year: the renewal is granted after that year, and the subscription stays
    // switched.
    test("a late renewal neither shortens a one-time year nor revives billing", async () => {
      const periodEnd = new Date(Date.now() + 2 * DAY);
      const userId = await makeUser(periodEnd);
      const subId = await makeSubscription(userId, {
        status: "active",
        currentPeriodEnd: periodEnd,
        nextBillingAt: periodEnd,
      });
      const renewalId = await makePendingPayment({
        userId,
        subscriptionId: subId,
        attemptKey: `subscription:${subId}:x:1`,
        orderId: "renewal-order",
        amount: 1000,
      });
      const { periodEnd: prepaidUntil } = await applyOneTimePayment({
        userId,
        amount: 12000,
        years: 1,
        payment: tossPayment("one-time-order", 12000),
      });
      toss.getPaymentByOrderId.mockResolvedValue(
        tossPayment("renewal-order", 1000),
      );

      expect(await reconcilePayment(renewalId)).toEqual({ state: "done" });

      const until = await supporterUntil(userId);
      expect(until! > prepaidUntil).toBe(true);
      const sub = await subscription(subId);
      expect(sub.status).toBe("switched_to_one_time");
      expect(sub.next_billing_at).toBeNull();
    });

    test("refunding a month pulls a stacked one-time year forward", async () => {
      const periodEnd = new Date(Date.now() + 20 * DAY);
      const userId = await makeUser();
      const subId = await makeSubscription(userId, { status: "incomplete" });
      const monthId = await makePendingPayment({
        userId,
        subscriptionId: subId,
        attemptKey: `subscription_initial:${subId}:1`,
        orderId: "month-order",
        amount: 1000,
      });
      await applySuccessfulCharge({
        subscriptionId: subId,
        userId,
        interval: "month",
        amount: 1000,
        from: new Date(periodEnd.getTime() - 30 * DAY),
        payment: tossPayment("month-order", 1000),
        paymentId: monthId,
      });
      const beforeOneTime = new Date();
      await applyOneTimePayment({
        userId,
        amount: 12000,
        years: 1,
        payment: tossPayment("year-order", 12000),
      });
      toss.getPaymentByOrderId.mockResolvedValue(
        tossPayment("month-order", 1000, {
          status: "CANCELED",
          cancels: [{ cancelAmount: 1000 }],
        }),
      );

      expect(await reconcilePayment(monthId)).toMatchObject({
        state: "refunded",
      });

      // The year now runs from when it was bought, not from the refunded
      // month's end.
      const until = (await supporterUntil(userId))!;
      const yearFromPurchase = new Date(beforeOneTime);
      yearFromPurchase.setFullYear(yearFromPurchase.getFullYear() + 1);
      expect(
        Math.abs(until.getTime() - yearFromPurchase.getTime()),
      ).toBeLessThan(2 * DAY);
    });
  });

  describe("retiring billing keys", () => {
    async function queued() {
      return (
        await db
          .selectFrom("retired_billing_keys")
          .select("billing_key")
          .orderBy("id")
          .execute()
      ).map((row) => row.billing_key);
    }

    // Nothing in the database queues keys any more; only retireBillingKey
    // does, and billing-key-writes-payment.test.ts keeps every path on it.
    test("the database does not queue keys on its own", async () => {
      const userId = await makeUser();
      const subId = await makeSubscription(userId, {
        status: "active",
        billingKey: "key-raw",
      });

      await db
        .updateTable("subscriptions")
        .set({ toss_billing_key: null })
        .where("id", "=", subId)
        .execute();

      expect(await queued()).toEqual([]);
    });

    test("retiring a key queues it and clears it in one transaction", async () => {
      const userId = await makeUser();
      const subId = await makeSubscription(userId, {
        status: "active",
        billingKey: "key-a",
      });

      const retired = await db
        .transaction()
        .execute((trx) => retireBillingKey(trx, { subscriptionId: subId }));

      expect(retired).toBe("key-a");
      expect((await subscription(subId)).toss_billing_key).toBeNull();
      expect(await queued()).toEqual(["key-a"]);

      // A subscription without a key has nothing to retire.
      expect(
        await db
          .transaction()
          .execute((trx) => retireBillingKey(trx, { subscriptionId: subId })),
      ).toBeNull();
      expect(await queued()).toEqual(["key-a"]);
    });

    test("a rolled-back transaction keeps the key where it was", async () => {
      const userId = await makeUser();
      const subId = await makeSubscription(userId, {
        status: "active",
        billingKey: "key-b",
      });

      await expect(
        db.transaction().execute(async (trx) => {
          await retireBillingKey(trx, { subscriptionId: subId });
          throw new Error("rollback");
        }),
      ).rejects.toThrow("rollback");

      expect((await subscription(subId)).toss_billing_key).toBe("key-b");
      expect(await queued()).toEqual([]);
    });

    test("deleting an account retires its key first", async () => {
      const userId = await makeUser();
      await makeSubscription(userId, { status: "active", billingKey: "key-c" });

      const retired = await db
        .transaction()
        .execute((trx) => deleteUserRow(trx, userId));

      expect(retired).toBe("key-c");
      expect(await queued()).toEqual(["key-c"]);
      expect(
        await db
          .selectFrom("users")
          .select("id")
          .where("id", "=", userId)
          .executeTakeFirst(),
      ).toBeUndefined();
    });

    test("a key Toss already deleted is cleared without being queued", async () => {
      const userId = await makeUser();
      const subId = await makeSubscription(userId, {
        status: "active",
        billingKey: "key-gone",
      });
      await db
        .insertInto("retired_billing_keys")
        .values({ billing_key: "key-gone" })
        .execute();

      const retired = await db
        .transaction()
        .execute((trx) =>
          retireBillingKey(
            trx,
            { subscriptionId: subId },
            { deletedAtToss: true },
          ),
        );

      expect(retired).toBeNull();
      expect((await subscription(subId)).toss_billing_key).toBeNull();
      expect(await queued()).toEqual([]);
    });

    test("a one-time purchase deletes the recurring key at Toss right away", async () => {
      const userId = await makeUser();
      await makeSubscription(userId, { status: "active", billingKey: "key-d" });

      await applyOneTimePayment({
        userId,
        amount: 12000,
        years: 1,
        payment: tossPayment("one-time-retire", 12000),
      });

      expect(toss.deleteBillingKey).toHaveBeenCalledWith("key-d");
      expect(await queued()).toEqual([]);
    });

    test("a key Toss would not delete stays queued for the cron", async () => {
      const userId = await makeUser();
      await makeSubscription(userId, { status: "active", billingKey: "key-e" });
      toss.deleteBillingKey.mockRejectedValue(
        new toss.TossApiError("server error", 500),
      );

      // The purchase itself still succeeds.
      await applyOneTimePayment({
        userId,
        amount: 12000,
        years: 1,
        payment: tossPayment("one-time-retire-2", 12000),
      });

      const [row] = await db
        .selectFrom("retired_billing_keys")
        .selectAll()
        .execute();
      expect(row).toMatchObject({ billing_key: "key-e", attempts: 1 });
    });

    test("a refunded renewal cancels the subscription and deletes its key", async () => {
      const periodEnd = new Date(Date.now() + 20 * DAY);
      const userId = await makeUser(periodEnd);
      const subId = await makeSubscription(userId, {
        status: "active",
        billingKey: "key-f",
        currentPeriodEnd: periodEnd,
        nextBillingAt: periodEnd,
      });
      const paymentId = await makePendingPayment({
        userId,
        subscriptionId: subId,
        attemptKey: `subscription:${subId}:refund:1`,
        orderId: "refunded-renewal",
        amount: 1000,
      });
      await db
        .updateTable("payments")
        .set({
          status: "done",
          paid_at: new Date(),
          period_start: new Date(),
          period_end: periodEnd,
        })
        .where("id", "=", paymentId)
        .execute();
      toss.getPaymentByOrderId.mockResolvedValue(
        tossPayment("refunded-renewal", 1000, {
          status: "CANCELED",
          cancels: [{ cancelAmount: 1000 }],
        }),
      );

      await reconcilePayment(paymentId);

      const sub = await subscription(subId);
      expect(sub.status).toBe("canceled");
      expect(sub.toss_billing_key).toBeNull();
      expect(toss.deleteBillingKey).toHaveBeenCalledWith("key-f");
      expect(await queued()).toEqual([]);
    });

    test("keys are deleted at Toss and forgotten once Toss confirms", async () => {
      await db
        .insertInto("retired_billing_keys")
        .values([
          { billing_key: "deleted" },
          { billing_key: "already-gone" },
          { billing_key: "refused" },
        ])
        .execute();
      toss.deleteBillingKey.mockImplementation(async (key) => {
        if (key === "already-gone") {
          throw new toss.TossApiError("not found", 404, "NOT_FOUND_BILLING");
        }
        if (key === "refused") {
          throw new toss.TossApiError("server error", 500);
        }
      });

      const now = new Date();
      expect(await deleteRetiredBillingKeys(now)).toEqual({
        deleted: 2,
        failed: 1,
      });

      const left = await db
        .selectFrom("retired_billing_keys")
        .selectAll()
        .execute();
      expect(left).toHaveLength(1);
      expect(left[0]).toMatchObject({
        billing_key: "refused",
        attempts: 1,
        last_error: "server error",
      });

      // Not retried right away, but again an hour later.
      toss.deleteBillingKey.mockClear();
      await deleteRetiredBillingKeys(new Date(now.getTime() + 60 * 1000));
      expect(toss.deleteBillingKey).not.toHaveBeenCalled();
      toss.deleteBillingKey.mockResolvedValue(undefined);
      toss.deleteBillingKey.mockImplementation(async () => {});
      await deleteRetiredBillingKeys(new Date(now.getTime() + 61 * 60 * 1000));
      expect(toss.deleteBillingKey).toHaveBeenCalledWith("refused");
      expect(await queued()).toEqual([]);
    });
  });

  describe("refunds", () => {
    async function paidPayment(userId: string) {
      const paymentId = await makePendingPayment({
        userId,
        subscriptionId: null,
        attemptKey: `one_time:1:refund-order-${userId}`,
        orderId: `refund-order-${userId}`,
        amount: 12000,
      });
      await applyOneTimePayment({
        userId,
        amount: 12000,
        years: 1,
        payment: tossPayment(`refund-order-${userId}`, 12000),
        paymentId,
      });
      return paymentId;
    }

    test("a payment Toss already canceled is recorded as refunded", async () => {
      const userId = await makeUser();
      const paymentId = await paidPayment(userId);
      toss.cancelPayment.mockRejectedValue(
        new toss.TossApiError("취소 불가", 403, "NOT_CANCELABLE_PAYMENT"),
      );
      toss.getPaymentByOrderId.mockResolvedValue(
        tossPayment(`refund-order-${userId}`, 12000, {
          status: "CANCELED",
          cancels: [{ cancelAmount: 12000 }],
        }),
      );

      await expect(
        refundPayment({ paymentId, overridePolicy: false, reason: "test" }),
      ).resolves.toMatchObject({ paymentId });

      const row = await db
        .selectFrom("payments")
        .select(["status", "refunded_amount"])
        .where("id", "=", paymentId)
        .executeTakeFirstOrThrow();
      expect(row).toEqual({ status: "canceled", refunded_amount: 12000 });
      expect(await supporterUntil(userId)).toBeNull();
    });

    test("a refund Toss refused is reported, and can be tried again", async () => {
      const userId = await makeUser();
      const paymentId = await paidPayment(userId);
      const refusal = new toss.TossApiError(
        "일시적 오류",
        400,
        "PROVIDER_ERROR",
      );
      toss.cancelPayment.mockRejectedValueOnce(refusal);
      toss.getPaymentByOrderId.mockResolvedValue(
        tossPayment(`refund-order-${userId}`, 12000),
      );

      await expect(
        refundPayment({ paymentId, overridePolicy: false, reason: "test" }),
      ).rejects.toBe(refusal);

      toss.cancelPayment.mockResolvedValueOnce(
        tossPayment(`refund-order-${userId}`, 12000, { status: "CANCELED" }),
      );
      toss.getPaymentByOrderId.mockResolvedValue(
        tossPayment(`refund-order-${userId}`, 12000, {
          status: "CANCELED",
          cancels: [{ cancelAmount: 12000 }],
        }),
      );
      await refundPayment({ paymentId, overridePolicy: false, reason: "test" });

      expect(toss.cancelPayment).toHaveBeenCalledTimes(2);
      for (const [params] of toss.cancelPayment.mock.calls) {
        expect(params).not.toHaveProperty("idempotencyKey");
      }
      expect(await supporterUntil(userId)).toBeNull();
    });

    test("a cancel that got no answer but went through is a refund", async () => {
      const userId = await makeUser();
      const paymentId = await paidPayment(userId);
      const subId = await makeSubscription(userId, { status: "active" });
      toss.cancelPayment.mockRejectedValue(new TypeError("fetch failed"));
      toss.getPaymentByOrderId.mockResolvedValue(
        tossPayment(`refund-order-${userId}`, 12000, {
          status: "CANCELED",
          cancels: [{ cancelAmount: 12000 }],
        }),
      );

      await expect(
        refundPayment({ paymentId, overridePolicy: false, reason: "test" }),
      ).resolves.toMatchObject({ paymentId, subscriptionCanceled: true });
      expect((await subscription(subId)).status).toBe("canceled");
    });

    // A refund made in the Toss dashboard, or one whose cancel call got no
    // answer, reaches 나루 only through the webhook or the refund sweep.
    test("a one-time refund seen only by reconciliation stops recurring billing", async () => {
      const userId = await makeUser();
      const paymentId = await paidPayment(userId);
      const subId = await makeSubscription(userId, {
        status: "active",
        billingKey: "later-key",
      });
      toss.getPaymentByOrderId.mockResolvedValue(
        tossPayment(`refund-order-${userId}`, 12000, {
          status: "CANCELED",
          cancels: [{ cancelAmount: 12000 }],
        }),
      );

      expect(await reconcilePayment(paymentId)).toMatchObject({
        state: "refunded",
        subscriptionCanceled: true,
      });

      const sub = await subscription(subId);
      expect(sub.status).toBe("canceled");
      expect(sub.toss_billing_key).toBeNull();
      expect(toss.deleteBillingKey).toHaveBeenCalledWith("later-key");
    });

    // Toss wants a webhook answered within 10 seconds, and deleting a key may
    // wait out the whole Toss timeout.
    test("a refund webhook leaves the key it retires to the cron", async () => {
      const userId = await makeUser();
      await paidPayment(userId);
      const subId = await makeSubscription(userId, {
        status: "active",
        billingKey: "webhook-key",
      });
      toss.getPaymentByOrderId.mockResolvedValue(
        tossPayment(`refund-order-${userId}`, 12000, {
          status: "CANCELED",
          cancels: [{ cancelAmount: 12000 }],
        }),
      );

      const response = await tossWebhook(
        new NextRequest("http://localhost/api/webhooks/toss", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            eventType: "PAYMENT_STATUS_CHANGED",
            createdAt: new Date().toISOString(),
            data: { orderId: `refund-order-${userId}`, status: "CANCELED" },
          }),
        }),
      );

      expect(response.status).toBe(200);
      expect((await subscription(subId)).toss_billing_key).toBeNull();
      expect(toss.deleteBillingKey).not.toHaveBeenCalled();
      const queued = await db
        .selectFrom("retired_billing_keys")
        .select("billing_key")
        .execute();
      expect(queued).toEqual([{ billing_key: "webhook-key" }]);

      await deleteRetiredBillingKeys();
      expect(toss.deleteBillingKey).toHaveBeenCalledWith("webhook-key");
    });

    test("a webhook is stored with its headers and signature check", async () => {
      const rawBody = JSON.stringify({
        eventType: "PAYMENT_STATUS_CHANGED",
        data: { orderId: "unknown-order" },
      });
      const previous = process.env.TOSS_BILLING_SECRET_KEY;
      process.env.TOSS_BILLING_SECRET_KEY = "test_sk_webhook";
      try {
        await tossWebhook(
          new NextRequest("http://localhost/api/webhooks/toss", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "toss-signature": `v1:${createHmac("sha256", "test_sk_webhook").update(rawBody).digest("base64")}`,
              cookie: "session=secret",
            },
            body: rawBody,
          }),
        );
      } finally {
        process.env.TOSS_BILLING_SECRET_KEY = previous;
      }

      const row = await db
        .selectFrom("toss_webhook_deliveries")
        .select(["headers", "signature_check", "outcome"])
        .executeTakeFirstOrThrow();
      expect(row.outcome).toBe("ignored: unknown order");
      expect(row.signature_check).toBe(
        "toss-signature verified (billing key, payload)",
      );
      const headers = JSON.parse(row.headers!);
      expect(headers["toss-signature"]).toMatch(/^v1:/);
      expect(headers).not.toHaveProperty("cookie");
    });

    test("a refund reconciled again does not cancel a plan started since", async () => {
      const userId = await makeUser();
      const paymentId = await paidPayment(userId);
      const subId = await makeSubscription(userId, { status: "active" });
      toss.getPaymentByOrderId.mockResolvedValue(
        tossPayment(`refund-order-${userId}`, 12000, {
          status: "PARTIAL_CANCELED",
          cancels: [{ cancelAmount: 6000 }],
        }),
      );
      await reconcilePayment(paymentId);
      expect((await subscription(subId)).status).toBe("canceled");

      // The supporter subscribes again; the old refund is checked again.
      await db
        .updateTable("subscriptions")
        .set({ status: "active", toss_billing_key: "new-key" })
        .where("id", "=", subId)
        .execute();
      expect(await reconcilePayment(paymentId)).toMatchObject({
        state: "refunded",
        subscriptionCanceled: false,
      });

      const sub = await subscription(subId);
      expect(sub.status).toBe("active");
      expect(sub.toss_billing_key).toBe("new-key");
    });

    test("a cancel that got no answer either way says so", async () => {
      const userId = await makeUser();
      const paymentId = await paidPayment(userId);
      toss.cancelPayment.mockRejectedValue(new TypeError("fetch failed"));
      toss.getPaymentByOrderId.mockResolvedValue(
        tossPayment(`refund-order-${userId}`, 12000),
      );

      await expect(
        refundPayment({ paymentId, overridePolicy: false, reason: "test" }),
      ).rejects.toMatchObject({ name: "RefundError", status: 503 });
    });
  });

  describe("cancellation mail", () => {
    async function paidOneTime(userId: string) {
      const orderId = `mail-order-${userId}`;
      const paymentId = await makePendingPayment({
        userId,
        subscriptionId: null,
        attemptKey: `one_time:1:${orderId}`,
        orderId,
        amount: 12000,
      });
      await applyOneTimePayment({
        userId,
        amount: 12000,
        years: 1,
        payment: tossPayment(orderId, 12000),
        paymentId,
      });
      return { orderId, paymentId };
    }

    function refundWebhook(orderId: string) {
      return tossWebhook(
        new NextRequest("http://localhost/api/webhooks/toss", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            eventType: "PAYMENT_STATUS_CHANGED",
            createdAt: new Date().toISOString(),
            data: { orderId, status: "CANCELED" },
          }),
        }),
      );
    }

    function cancelRequest(userId: string) {
      auth.validateRequest.mockResolvedValue({
        user: { id: userId },
        session: {},
      } as Awaited<ReturnType<typeof auth.validateRequest>>);
      return cancelSubscriptionRoute(
        new NextRequest("http://localhost/api/account/subscription/cancel", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        }),
      );
    }

    test("a refund is mailed once, however many times it is seen", async () => {
      const userId = await makeUser();
      const { orderId, paymentId } = await paidOneTime(userId);
      await makeSubscription(userId, { status: "active" });
      const canceled = tossPayment(orderId, 12000, {
        status: "CANCELED",
        cancels: [
          { cancelAmount: 12000, canceledAt: "2026-10-01T03:00:00+09:00" },
        ],
      });
      toss.cancelPayment.mockResolvedValue(canceled);
      toss.getPaymentByOrderId.mockResolvedValue(canceled);

      await refundPayment({ paymentId, overridePolicy: false, reason: "test" });
      await refundWebhook(orderId);
      await reconcilePayment(paymentId);

      expect(email.sendPaymentCanceledEmail).toHaveBeenCalledTimes(1);
      expect(email.sendPaymentCanceledEmail).toHaveBeenCalledWith(
        expect.objectContaining({
          amount: 12000,
          refundedAmount: 12000,
          orderId,
          refundedAt: new Date("2026-10-01T03:00:00+09:00"),
          supporterUntil: null,
          subscriptionCanceled: true,
        }),
      );
      // The refund mail says the plan stopped; no second mail for it.
      expect(email.sendSubscriptionCanceledEmail).not.toHaveBeenCalled();
    });

    // As when a refund's own reconciliation and the webhook it sets off run
    // together.
    test("two reconciliations that see one refund at once mail it once", async () => {
      const userId = await makeUser();
      const { orderId, paymentId } = await paidOneTime(userId);
      // Both have read the payment before either records the refund.
      let arrived = 0;
      let release!: () => void;
      const bothArrived = new Promise<void>((resolve) => (release = resolve));
      toss.getPaymentByOrderId.mockImplementation(async () => {
        arrived += 1;
        if (arrived === 2) release();
        await bothArrived;
        return tossPayment(orderId, 12000, {
          status: "CANCELED",
          cancels: [{ cancelAmount: 12000 }],
        });
      });

      await Promise.all([
        reconcilePayment(paymentId),
        reconcilePayment(paymentId),
      ]);

      expect(arrived).toBe(2);
      expect(email.sendPaymentCanceledEmail).toHaveBeenCalledTimes(1);
    });

    test("a plan a refund stops before the refund shows is mailed on its own", async () => {
      const userId = await makeUser();
      const { orderId, paymentId } = await paidOneTime(userId);
      await makeSubscription(userId, { status: "active" });
      toss.cancelPayment.mockResolvedValue(
        tossPayment(orderId, 12000, { status: "CANCELED" }),
      );
      // Toss's lookup still shows the payment paid.
      toss.getPaymentByOrderId.mockResolvedValue(tossPayment(orderId, 12000));

      await refundPayment({ paymentId, overridePolicy: false, reason: "test" });

      expect(email.sendPaymentCanceledEmail).not.toHaveBeenCalled();
      expect(email.sendSubscriptionCanceledEmail).toHaveBeenCalledTimes(1);
      expect(email.sendSubscriptionCanceledEmail).toHaveBeenCalledWith(
        expect.objectContaining({ reason: "refund" }),
      );

      toss.getPaymentByOrderId.mockResolvedValue(
        tossPayment(orderId, 12000, {
          status: "CANCELED",
          cancels: [{ cancelAmount: 12000 }],
        }),
      );
      await reconcilePayment(paymentId);
      expect(email.sendPaymentCanceledEmail).toHaveBeenCalledWith(
        expect.objectContaining({ subscriptionCanceled: false }),
      );
    });

    test("canceling a plan mails the paid time left, once", async () => {
      const paidUntil = new Date(Date.now() + 20 * DAY);
      const userId = await makeUser(paidUntil);
      const subId = await makeSubscription(userId, { status: "active" });

      expect((await cancelRequest(userId)).status).toBe(200);
      expect((await cancelRequest(userId)).status).toBe(200);

      expect((await subscription(subId)).status).toBe("canceled");
      expect(email.sendSubscriptionCanceledEmail).toHaveBeenCalledTimes(1);
      expect(email.sendSubscriptionCanceledEmail).toHaveBeenCalledWith(
        expect.objectContaining({
          email: expect.stringMatching(/@example\.com$/),
          reason: "user",
          supporterUntil: paidUntil,
        }),
      );
    });

    test("calling off a scheduled plan says no charge was made", async () => {
      const userId = await makeUser();
      const subId = await makeSubscription(userId, {
        status: "scheduled",
        nextBillingAt: new Date(Date.now() + 5 * DAY),
      });

      await cancelRequest(userId);

      expect((await subscription(subId)).status).toBe("switched_to_one_time");
      expect(email.sendSubscriptionCanceledEmail).toHaveBeenCalledWith(
        expect.objectContaining({
          reason: "user_schedule",
          supporterUntil: null,
        }),
      );
    });

    test("an unverified address is not mailed", async () => {
      const userId = await makeUser();
      await db
        .updateTable("users")
        .set({ email_verified_at: null })
        .where("id", "=", userId)
        .execute();
      await makeSubscription(userId, { status: "active" });

      await cancelRequest(userId);

      expect(email.sendSubscriptionCanceledEmail).not.toHaveBeenCalled();
    });

    test("BILLING_DELETED mails a plan it stops, not one already stopped", async () => {
      process.env.TOSS_BILLING_SECRET_KEY = "test_sk_billing";
      process.env.TOSS_PAYMENT_SECRET_KEY = "test_sk_payment";
      const userId = await makeUser();
      const activeId = await makeSubscription(userId, {
        status: "active",
        billingKey: "deleted-active",
      });
      await runLabAction({
        action: "billing-deleted",
        subscriptionId: activeId,
      });
      expect(email.sendSubscriptionCanceledEmail).toHaveBeenCalledTimes(1);
      expect(email.sendSubscriptionCanceledEmail).toHaveBeenCalledWith(
        expect.objectContaining({ reason: "billing_key_deleted" }),
      );

      const otherId = await makeSubscription(await makeUser(), {
        status: "canceled",
        billingKey: "deleted-canceled",
      });
      await runLabAction({
        action: "billing-deleted",
        subscriptionId: otherId,
      });
      expect(email.sendSubscriptionCanceledEmail).toHaveBeenCalledTimes(1);
    });
  });

  describe("one-time payments left unconfirmed", () => {
    async function authenticated(createdMinutesAgo = 5) {
      const userId = await makeUser();
      const orderId = `one-time-${userId}`;
      const paymentId = await makePendingPayment({
        userId,
        subscriptionId: null,
        attemptKey: `one_time:1:${orderId}`,
        orderId,
        amount: 12000,
      });
      await db
        .updateTable("payments")
        .set({ created_at: new Date(Date.now() - createdMinutesAgo * 60_000) })
        .where("id", "=", paymentId)
        .execute();
      return { userId, orderId, paymentId };
    }

    async function status(paymentId: string) {
      const row = await db
        .selectFrom("payments")
        .select("status")
        .where("id", "=", paymentId)
        .executeTakeFirstOrThrow();
      return row.status;
    }

    test("an authenticated payment nobody confirmed is confirmed and thanked once", async () => {
      const { userId, orderId, paymentId } = await authenticated();
      toss.getPaymentByOrderId.mockResolvedValue(
        tossPayment(orderId, 12000, { status: "IN_PROGRESS" }),
      );
      toss.confirmPayment.mockResolvedValue(tossPayment(orderId, 12000));

      expect(await reconcilePayment(paymentId)).toEqual({ state: "done" });

      // Not the order id: the callback's first confirm used that key, and
      // Toss would only replay its answer.
      expect(toss.confirmPayment).toHaveBeenCalledWith(
        { paymentKey: `pk-${orderId}`, orderId, amount: 12000 },
        expect.stringMatching(new RegExp(`^${orderId}:.+`)),
      );
      expect(await status(paymentId)).toBe("done");
      expect((await supporterUntil(userId))! > new Date()).toBe(true);
      expect(email.sendSupportThankYouEmail).toHaveBeenCalledTimes(1);

      toss.getPaymentByOrderId.mockResolvedValue(tossPayment(orderId, 12000));
      await reconcilePayment(paymentId);
      expect(email.sendSupportThankYouEmail).toHaveBeenCalledTimes(1);
    });

    test("a confirm that fails leaves the payment for Toss to settle", async () => {
      const { orderId, paymentId } = await authenticated();
      toss.getPaymentByOrderId.mockResolvedValue(
        tossPayment(orderId, 12000, { status: "IN_PROGRESS" }),
      );
      toss.confirmPayment.mockRejectedValue(
        new toss.TossApiError("처리 중", 409, "IDEMPOTENT_REQUEST_PROCESSING"),
      );

      expect(await reconcilePayment(paymentId)).toEqual({ state: "pending" });
      expect(await status(paymentId)).toBe("pending");
      expect(email.sendSupportThankYouEmail).not.toHaveBeenCalled();
    });

    // The payment window is open for 30 minutes from when it opens, which is
    // after prepare, and a payment authenticated in it has 10 more.
    test("an order Toss has not heard of outlives its payment window", async () => {
      const young = await authenticated(40);
      const old = await authenticated(50);

      expect(await reconcilePayment(young.paymentId)).toEqual({
        state: "pending",
      });
      expect(await reconcilePayment(old.paymentId)).toEqual({
        state: "expired",
      });
    });

    test("applying a payment twice grants it once", async () => {
      const { userId, orderId, paymentId } = await authenticated();
      const apply = () =>
        applyOneTimePayment({
          userId,
          amount: 12000,
          years: 1,
          payment: tossPayment(orderId, 12000),
          paymentId,
        });

      expect(await apply()).toMatchObject({ granted: true });
      expect(await apply()).toMatchObject({ granted: false });
    });
  });

  describe("renewal retries", () => {
    async function dueSubscription() {
      const periodEnd = new Date(Date.now() - 60 * 1000);
      const userId = await makeUser(periodEnd);
      const subId = await makeSubscription(userId, {
        status: "active",
        currentPeriodEnd: periodEnd,
        nextBillingAt: periodEnd,
      });
      return { userId, subId, periodEnd };
    }

    function attempts(subId: string) {
      return db
        .selectFrom("payments")
        .select(["attempt_key", "order_id", "status"])
        .where("subscription_id", "=", subId)
        .orderBy("id")
        .execute();
    }

    test("an order Toss never saw is replaced, not replayed", async () => {
      const { subId } = await dueSubscription();
      toss.chargeBillingKey.mockRejectedValueOnce(
        new toss.TossApiError("server error", 500),
      );

      await chargeDueSubscriptions();
      const [first] = await attempts(subId);
      expect(first.status).toBe("pending");
      expect((await subscription(subId)).failed_charge_count).toBe(0);

      // The reconciler finds nothing at Toss and expires the order.
      await db
        .updateTable("payments")
        .set({ status: "expired" })
        .where("order_id", "=", first.order_id)
        .execute();
      toss.chargeBillingKey.mockImplementation(async (params) =>
        tossPayment(params.orderId, params.amount),
      );

      await chargeDueSubscriptions();

      const [, second] = await attempts(subId);
      expect(second.order_id).not.toBe(first.order_id);
      expect(second.attempt_key).toBe(`${first.attempt_key}:r1`);
      expect(second.status).toBe("done");
      const lastCharge = toss.chargeBillingKey.mock.calls.at(-1)![0];
      expect(lastCharge.orderId).toBe(second.order_id);
      expect(lastCharge.idempotencyKey).toBe(second.order_id);
    });

    // Toss was down: the charge ended ambiguously and the reconciler could not
    // look the order up, so it outlived the expiry window still pending. Once
    // Toss is back, the cron charges it while the reconciler, finding no such
    // order yet, would expire it.
    test("an order being charged is not expired under the charge", async () => {
      const { userId, subId, periodEnd } = await dueSubscription();
      toss.chargeBillingKey.mockRejectedValueOnce(
        new toss.TossApiError("server error", 500),
      );
      await chargeDueSubscriptions();
      const [first] = await attempts(subId);
      const paymentId = (
        await db
          .selectFrom("payments")
          .select("id")
          .where("order_id", "=", first.order_id)
          .executeTakeFirstOrThrow()
      ).id;
      await db
        .updateTable("payments")
        .set({ created_at: new Date(Date.now() - DAY) })
        .where("id", "=", paymentId)
        .execute();

      let reconciledMidCharge: unknown;
      toss.chargeBillingKey.mockImplementation(async (params) => {
        reconciledMidCharge = await reconcilePayment(paymentId);
        return tossPayment(params.orderId, params.amount);
      });

      await chargeDueSubscriptions();

      expect(reconciledMidCharge).toEqual({ state: "pending" });
      const all = await attempts(subId);
      expect(all).toHaveLength(1);
      expect(all[0]).toMatchObject({
        order_id: first.order_id,
        status: "done",
      });
      expect((await supporterUntil(userId))! > periodEnd).toBe(true);

      // Nothing is left for a later run to charge again.
      toss.chargeBillingKey.mockClear();
      await chargeDueSubscriptions();
      expect(toss.chargeBillingKey).not.toHaveBeenCalled();
    });

    test("a charge approved for an order settled meanwhile is flagged", async () => {
      const { userId, subId, periodEnd } = await dueSubscription();
      // Something else settles the order while Toss is approving it.
      toss.chargeBillingKey.mockImplementation(async (params) => {
        await db
          .updateTable("payments")
          .set({ status: "expired" })
          .where("order_id", "=", params.orderId)
          .execute();
        return tossPayment(params.orderId, params.amount);
      });

      await chargeDueSubscriptions();

      const [attempt] = await attempts(subId);
      expect(attempt.status).toBe("expired");
      expect(await supporterUntil(userId)).toEqual(periodEnd);
      const orphaned = await db
        .selectFrom("payment_events")
        .select(["kind", "summary", "user_id"])
        .where("kind", "=", "charge_orphaned")
        .execute();
      expect(orphaned).toHaveLength(1);
      expect(orphaned[0].user_id).toBe(userId);
      expect(orphaned[0].summary).toContain(attempt.order_id);
      expect(orphaned[0].summary).toContain(`pk-${attempt.order_id}`);
    });

    describe("recovering it", () => {
      async function orphaned() {
        const due = await dueSubscription();
        toss.chargeBillingKey.mockImplementation(async (params) => {
          await db
            .updateTable("payments")
            .set({ status: "expired" })
            .where("order_id", "=", params.orderId)
            .execute();
          return tossPayment(params.orderId, params.amount);
        });
        await chargeDueSubscriptions();
        const [attempt] = await attempts(due.subId);
        const row = await db
          .selectFrom("payments")
          .select("id")
          .where("order_id", "=", attempt.order_id)
          .executeTakeFirstOrThrow();
        return { ...due, paymentId: row.id, orderId: attempt.order_id };
      }

      function orphanedRows() {
        return db
          .selectFrom("payments")
          .select("id")
          .where(PAYMENT_FILTERS.orphaned.condition(new Date()))
          .execute();
      }

      test("a charge Toss approved is granted, and leaves the list", async () => {
        const { userId, subId, periodEnd, paymentId, orderId } =
          await orphaned();
        expect(await orphanedRows()).toEqual([{ id: paymentId }]);
        toss.getPaymentByOrderId.mockResolvedValue(tossPayment(orderId, 1000));

        expect(await recoverOrphanedCharge(paymentId)).toEqual({
          state: "recovered",
          result: { state: "done" },
        });

        const [attempt] = await attempts(subId);
        expect(attempt.status).toBe("done");
        expect((await supporterUntil(userId))! > periodEnd).toBe(true);
        expect((await subscription(subId)).status).toBe("active");
        expect(await orphanedRows()).toEqual([]);
        expect(email.sendRecurringChargeReceiptEmail).toHaveBeenCalledTimes(1);
      });

      test("an order Toss did not complete is left alone", async () => {
        const { userId, periodEnd, paymentId, orderId } = await orphaned();
        toss.getPaymentByOrderId.mockResolvedValue(
          tossPayment(orderId, 1000, { status: "CANCELED" }),
        );

        expect(await recoverOrphanedCharge(paymentId)).toEqual({
          state: "not_paid",
          tossStatus: "CANCELED",
        });
        expect(await supporterUntil(userId)).toEqual(periodEnd);
        expect(await orphanedRows()).toEqual([{ id: paymentId }]);
      });

      test("a payment that is not settled cannot be recovered", async () => {
        const { subId } = await dueSubscription();
        toss.chargeBillingKey.mockImplementation(async (params) =>
          tossPayment(params.orderId, params.amount),
        );
        await chargeDueSubscriptions();
        const row = await db
          .selectFrom("payments")
          .select("id")
          .where("subscription_id", "=", subId)
          .executeTakeFirstOrThrow();

        await expect(recoverOrphanedCharge(row.id)).rejects.toMatchObject({
          name: "RecoveryError",
        });
      });
    });

    test("an ordinary renewal flags nothing", async () => {
      await dueSubscription();
      toss.chargeBillingKey.mockImplementation(async (params) =>
        tossPayment(params.orderId, params.amount),
      );

      await chargeDueSubscriptions();

      const orphaned = await db
        .selectFrom("payment_events")
        .select("id")
        .where("kind", "=", "charge_orphaned")
        .execute();
      expect(orphaned).toHaveLength(0);
    });

    test("a pending order is retried with the same order and key", async () => {
      const { subId } = await dueSubscription();
      toss.chargeBillingKey.mockRejectedValue(
        new toss.TossApiError("server error", 500),
      );

      await chargeDueSubscriptions();
      await chargeDueSubscriptions();

      const [first, second] = toss.chargeBillingKey.mock.calls.map(
        ([params]) => params,
      );
      expect(second.orderId).toBe(first.orderId);
      expect(second.idempotencyKey).toBe(first.idempotencyKey);
      expect(await attempts(subId)).toHaveLength(1);
    });

    test("an order Toss declined counts as a failed try without a new charge", async () => {
      const { subId } = await dueSubscription();
      toss.chargeBillingKey.mockRejectedValueOnce(
        new toss.TossApiError("server error", 500),
      );
      await chargeDueSubscriptions();
      const [first] = await attempts(subId);
      // The reconciler learns Toss declined it.
      await db
        .updateTable("payments")
        .set({ status: "aborted" })
        .where("order_id", "=", first.order_id)
        .execute();

      await chargeDueSubscriptions();

      expect(toss.chargeBillingKey).toHaveBeenCalledTimes(1);
      const sub = await subscription(subId);
      expect(sub.failed_charge_count).toBe(1);
      expect(sub.status).toBe("active");
      expect(sub.charging_started_at).toBeNull();
      expect((await attempts(subId))[0].status).toBe("aborted");
      expect(email.sendSubscriptionPaymentGraceEmail).toHaveBeenCalledTimes(1);
    });

    test("an order Toss approved despite an error is granted, not failed", async () => {
      const { subId } = await dueSubscription();
      toss.chargeBillingKey.mockImplementation(async (params) => {
        toss.getPaymentByOrderId.mockResolvedValue(
          tossPayment(params.orderId, params.amount),
        );
        throw new toss.TossApiError("일시적인 오류", 400, "PROVIDER_ERROR");
      });

      await chargeDueSubscriptions();

      const sub = await subscription(subId);
      expect(sub.status).toBe("active");
      expect(sub.failed_charge_count).toBe(0);
      expect((await attempts(subId))[0].status).toBe("done");
      expect(email.sendSubscriptionPaymentGraceEmail).not.toHaveBeenCalled();
      expect(email.sendRecurringChargeReceiptEmail).toHaveBeenCalledTimes(1);
    });

    test.each([
      ["a temporary fault", 400, "PROVIDER_ERROR"],
      ["a key Toss does not accept", 401, "UNAUTHORIZED_KEY"],
    ])("%s is not held against the card", async (_label, status, code) => {
      const { subId } = await dueSubscription();
      toss.chargeBillingKey.mockRejectedValue(
        new toss.TossApiError("refused", status, code),
      );

      await chargeDueSubscriptions();

      const sub = await subscription(subId);
      expect(sub.status).toBe("active");
      expect(sub.failed_charge_count).toBe(0);
      expect(sub.charging_started_at).toBeNull();
      expect((await attempts(subId))[0].status).toBe("pending");
      expect(email.sendSubscriptionPaymentGraceEmail).not.toHaveBeenCalled();
    });

    test("a renewal settled late by the reconciler sends one receipt", async () => {
      const { subId } = await dueSubscription();
      toss.chargeBillingKey.mockRejectedValue(
        new toss.TossApiError("server error", 500),
      );
      await chargeDueSubscriptions();
      expect(email.sendRecurringChargeReceiptEmail).not.toHaveBeenCalled();

      const [first] = await attempts(subId);
      toss.getPaymentByOrderId.mockResolvedValue(
        tossPayment(first.order_id, 1000),
      );
      const { id } = await db
        .selectFrom("payments")
        .select("id")
        .where("order_id", "=", first.order_id)
        .executeTakeFirstOrThrow();
      await reconcilePayment(id);
      await reconcilePayment(id);

      expect((await attempts(subId))[0].status).toBe("done");
      expect(email.sendRecurringChargeReceiptEmail).toHaveBeenCalledTimes(1);
    });

    test("a pending order Toss reports as declined is not charged again", async () => {
      const { subId } = await dueSubscription();
      toss.chargeBillingKey.mockRejectedValueOnce(
        new toss.TossApiError("server error", 500),
      );
      await chargeDueSubscriptions();
      const [first] = await attempts(subId);
      toss.getPaymentByOrderId.mockResolvedValue(
        tossPayment(first.order_id, 1000, { status: "ABORTED" }),
      );

      await chargeDueSubscriptions();

      expect(toss.chargeBillingKey).toHaveBeenCalledTimes(1);
      expect((await subscription(subId)).failed_charge_count).toBe(1);
    });
  });

  describe("the subscribe flow", () => {
    // A user part-way through signup: prepare has run, Toss has redirected
    // back with an authKey.
    async function signingUp(supporterUntilAt: Date | null = null) {
      const userId = await makeUser(supporterUntilAt);
      const customerKey = randomUUID();
      await db
        .updateTable("users")
        .set({ toss_customer_key: customerKey })
        .where("id", "=", userId)
        .execute();
      const subId = await makeSubscription(userId, {
        status: "incomplete",
        billingKey: null,
      });
      toss.issueBillingKey.mockResolvedValue({
        billingKey: "issued-key",
        customerKey,
      });
      return { userId, subId, customerKey };
    }

    function confirm(userId: string, customerKey: string) {
      return confirmSubscription({ userId, authKey: "auth", customerKey });
    }

    function queuedKeys() {
      return db
        .selectFrom("retired_billing_keys")
        .select("billing_key")
        .execute();
    }

    test("charges the first period and activates", async () => {
      const { userId, subId, customerKey } = await signingUp();
      toss.chargeBillingKey.mockImplementation(async (params) =>
        tossPayment(params.orderId, params.amount),
      );

      expect(await confirm(userId, customerKey)).toMatchObject({ ok: true });

      const sub = await subscription(subId);
      expect(sub.status).toBe("active");
      expect(sub.toss_billing_key).toBe("issued-key");
      expect(toss.chargeBillingKey).toHaveBeenCalledTimes(1);

      // A reloaded callback reports the subscription without thanking twice.
      expect(await confirm(userId, customerKey)).toMatchObject({ ok: true });
      expect(email.sendSupportThankYouEmail).toHaveBeenCalledTimes(1);
      expect(email.sendRecurringChargeReceiptEmail).not.toHaveBeenCalled();
    });

    // The cancel does not wait for the confirm's lease.
    test("a cancel that lands while Toss issues the key gets no key and no charge", async () => {
      const { userId, subId, customerKey } = await signingUp();
      toss.issueBillingKey.mockImplementation(async () => {
        await db
          .updateTable("subscriptions")
          .set({ status: "canceled" })
          .where("id", "=", subId)
          .execute();
        return { billingKey: "orphan-key", customerKey };
      });

      const result = await confirm(userId, customerKey);

      expect(result).toMatchObject({ ok: false, status: 409 });
      const sub = await subscription(subId);
      expect(sub.status).toBe("canceled");
      expect(sub.toss_billing_key).toBeNull();
      expect(toss.chargeBillingKey).not.toHaveBeenCalled();
      expect(toss.deleteBillingKey).toHaveBeenCalledWith("orphan-key");
      expect(await queuedKeys()).toEqual([]);
    });

    test("a declined first charge retires the key it was made with", async () => {
      const { userId, subId, customerKey } = await signingUp();
      toss.chargeBillingKey.mockRejectedValue(
        new toss.TossApiError("card declined", 403, "REJECT_CARD_PAYMENT"),
      );

      expect(await confirm(userId, customerKey)).toMatchObject({
        ok: false,
        status: 402,
      });

      const sub = await subscription(subId);
      expect(sub.status).toBe("incomplete");
      expect(sub.toss_billing_key).toBeNull();
      expect(sub.charging_started_at).toBeNull();
      expect(toss.deleteBillingKey).toHaveBeenCalledWith("issued-key");
      const [attempt] = await db
        .selectFrom("payments")
        .select("status")
        .where("subscription_id", "=", subId)
        .execute();
      expect(attempt.status).toBe("failed");

      // Reloading the callback cannot charge the card again: the signup's
      // registration is spent with its key, so Toss is not even asked — its
      // replay would hand back the key just retired.
      toss.issueBillingKey.mockClear();
      expect(await confirm(userId, customerKey)).toMatchObject({
        ok: false,
        status: 409,
      });
      expect(toss.issueBillingKey).not.toHaveBeenCalled();
      expect(toss.chargeBillingKey).toHaveBeenCalledTimes(1);
    });

    test("a temporary fault on the first charge keeps the key for the retry", async () => {
      const { userId, subId, customerKey } = await signingUp();
      toss.chargeBillingKey.mockRejectedValue(
        new toss.TossApiError("일시적인 오류", 400, "PROVIDER_ERROR"),
      );

      expect(await confirm(userId, customerKey)).toMatchObject({
        ok: false,
        status: 503,
      });

      expect((await subscription(subId)).toss_billing_key).toBe("issued-key");
      expect(toss.deleteBillingKey).not.toHaveBeenCalled();
      const [attempt] = await db
        .selectFrom("payments")
        .select("status")
        .where("subscription_id", "=", subId)
        .execute();
      expect(attempt.status).toBe("pending");
    });

    test("a first charge Toss approved despite an error activates", async () => {
      const { userId, subId, customerKey } = await signingUp();
      toss.chargeBillingKey.mockImplementation(async (params) => {
        toss.getPaymentByOrderId.mockResolvedValue(
          tossPayment(params.orderId, params.amount),
        );
        throw new toss.TossApiError(
          "처리 중",
          400,
          "ALREADY_PROCESSING_REQUEST",
        );
      });

      expect(await confirm(userId, customerKey)).toMatchObject({ ok: true });
      expect((await subscription(subId)).status).toBe("active");
      expect(toss.deleteBillingKey).not.toHaveBeenCalled();
    });

    test("an ambiguous first charge keeps its key and order for the retry", async () => {
      const { userId, subId, customerKey } = await signingUp();
      toss.chargeBillingKey.mockRejectedValue(
        new toss.TossApiError("server error", 500),
      );

      expect(await confirm(userId, customerKey)).toMatchObject({
        ok: false,
        status: 503,
      });

      expect((await subscription(subId)).toss_billing_key).toBe("issued-key");
      expect(toss.deleteBillingKey).not.toHaveBeenCalled();
    });

    test("a key Toss could not confirm issuing is asked for again, not reported as a failure", async () => {
      const { userId, subId, customerKey } = await signingUp();
      toss.issueBillingKey.mockRejectedValue(new TypeError("fetch failed"));

      expect(await confirm(userId, customerKey)).toMatchObject({
        ok: false,
        status: 503,
      });
      expect((await subscription(subId)).charging_started_at).toBeNull();
    });

    test("a stale callback cannot charge a subscription that moved on", async () => {
      const { userId, subId, customerKey } = await signingUp();
      await db
        .updateTable("subscriptions")
        .set({ status: "past_due", toss_billing_key: "old-key" })
        .where("id", "=", subId)
        .execute();

      expect(await confirm(userId, customerKey)).toMatchObject({
        ok: false,
        status: 409,
      });
      expect(toss.issueBillingKey).not.toHaveBeenCalled();
      expect(toss.chargeBillingKey).not.toHaveBeenCalled();
    });

    test("a doubled callback on a scheduled start reports the schedule", async () => {
      const startsAt = new Date(Date.now() + 10 * DAY);
      const { userId, subId, customerKey } = await signingUp(startsAt);

      const first = await confirm(userId, customerKey);
      const second = await confirm(userId, customerKey);

      expect(first).toMatchObject({ ok: true, scheduled: true });
      expect(second).toEqual(first);
      expect(toss.issueBillingKey).toHaveBeenCalledTimes(1);
      expect((await subscription(subId)).status).toBe("scheduled");
    });

    test("a new card waits for a renewal charge in flight", async () => {
      const userId = await makeUser(new Date(Date.now() - DAY));
      const subId = await makeSubscription(userId, {
        status: "past_due",
        billingKey: "old-key",
      });
      await db
        .updateTable("subscriptions")
        .set({ charging_started_at: new Date() })
        .where("id", "=", subId)
        .execute();

      expect(
        await prepareSubscription({ userId, interval: "month" }),
      ).toMatchObject({ ok: false, status: 409 });

      const sub = await subscription(subId);
      expect(sub.status).toBe("past_due");
      expect(sub.toss_billing_key).toBe("old-key");
    });

    test("a new card waits until an unsettled charge is known", async () => {
      const userId = await makeUser(new Date(Date.now() - DAY));
      const subId = await makeSubscription(userId, {
        status: "past_due",
        billingKey: "old-key",
      });
      await makePendingPayment({
        userId,
        subscriptionId: subId,
        attemptKey: `subscription:${subId}:x:1`,
        orderId: "unsettled",
        amount: 1000,
      });

      // Toss has not heard of it yet, and it is too young to expire.
      expect(
        await prepareSubscription({ userId, interval: "year" }),
      ).toMatchObject({ ok: false, status: 409 });
      expect((await subscription(subId)).toss_billing_key).toBe("old-key");

      // Once Toss reports it paid, the subscription is simply active again.
      toss.getPaymentByOrderId.mockResolvedValue(
        tossPayment("unsettled", 1000),
      );
      expect(
        await prepareSubscription({ userId, interval: "year" }),
      ).toMatchObject({ ok: false, status: 409 });
      const sub = await subscription(subId);
      expect(sub.status).toBe("active");
      expect(sub.toss_billing_key).toBe("old-key");
    });

    test("a renewal paid after the old key was retired leaves room for the new card", async () => {
      const { userId, subId, customerKey } = await signingUp();
      const paymentId = await makePendingPayment({
        userId,
        subscriptionId: subId,
        attemptKey: `subscription:${subId}:late:1`,
        orderId: "late-renewal",
        amount: 1000,
      });
      toss.getPaymentByOrderId.mockResolvedValue(
        tossPayment("late-renewal", 1000),
      );

      await reconcilePayment(paymentId);

      let sub = await subscription(subId);
      expect(sub.status).toBe("incomplete");
      expect(sub.next_billing_at).toBeNull();
      expect((await supporterUntil(userId))! > new Date()).toBe(true);

      // The new card's confirm stores its key and starts after the paid month.
      toss.getPaymentByOrderId.mockRejectedValue(
        new toss.TossApiError("not found", 404),
      );
      expect(await confirm(userId, customerKey)).toMatchObject({
        ok: true,
        scheduled: true,
      });
      sub = await subscription(subId);
      expect(sub.status).toBe("scheduled");
      expect(sub.toss_billing_key).toBe("issued-key");
      expect(toss.chargeBillingKey).not.toHaveBeenCalled();
    });
  });

  describe("card registrations", () => {
    function events(kind: string) {
      return db
        .selectFrom("payment_events")
        .select("summary")
        .where("kind", "=", kind)
        .execute();
    }

    // Toss replays the key it issued for an authKey for 15 days, so an old
    // callback would otherwise bring back a key that was since retired.
    test("a callback reopened after a new prepare is refused", async () => {
      const userId = await makeUser();
      const first = await prepareSubscription({ userId, interval: "month" });
      const second = await prepareSubscription({ userId, interval: "month" });
      if (!first.ok || !second.ok) throw new Error("prepare failed");
      expect(second.registrationId).not.toBe(first.registrationId);
      toss.issueBillingKey.mockResolvedValue({
        billingKey: "new-key",
        customerKey: second.customerKey,
      });
      toss.chargeBillingKey.mockImplementation(async (params) =>
        tossPayment(params.orderId, params.amount),
      );

      for (const registrationId of [first.registrationId, null]) {
        expect(
          await confirmSubscription({
            userId,
            authKey: "old-auth",
            customerKey: first.customerKey,
            registrationId,
          }),
        ).toMatchObject({ ok: false, status: 409 });
      }
      expect(toss.issueBillingKey).not.toHaveBeenCalled();

      expect(
        await confirmSubscription({
          userId,
          authKey: "new-auth",
          customerKey: second.customerKey,
          registrationId: second.registrationId,
        }),
      ).toMatchObject({ ok: true });
      const sub = await db
        .selectFrom("subscriptions")
        .select(["status", "toss_billing_key"])
        .where("user_id", "=", userId)
        .executeTakeFirstOrThrow();
      expect(sub).toEqual({ status: "active", toss_billing_key: "new-key" });
    });

    async function running(values: Parameters<typeof makeSubscription>[1]) {
      const userId = await makeUser(new Date(Date.now() + 10 * DAY));
      const subId = await makeSubscription(userId, values);
      const prepared = await prepareCardChange({ userId });
      if (!prepared.ok) throw new Error(prepared.message);
      toss.issueBillingKey.mockResolvedValue({
        billingKey: "new-key",
        customerKey: prepared.customerKey,
      });
      const confirm = () =>
        confirmSubscription({
          userId,
          authKey: "auth",
          customerKey: prepared.customerKey,
          registrationId: prepared.registrationId,
        });
      return { userId, subId, prepared, confirm };
    }

    test("a card change swaps the key and retires the old one", async () => {
      const { subId, confirm } = await running({
        status: "active",
        billingKey: "old-key",
        currentPeriodEnd: new Date(Date.now() + 10 * DAY),
        nextBillingAt: new Date(Date.now() + 10 * DAY),
      });

      expect(await confirm()).toMatchObject({ ok: true, cardChanged: true });

      const sub = await subscription(subId);
      expect(sub.status).toBe("active");
      expect(sub.toss_billing_key).toBe("new-key");
      expect(sub.charging_started_at).toBeNull();
      expect(toss.deleteBillingKey).toHaveBeenCalledWith("old-key");
      expect(toss.chargeBillingKey).not.toHaveBeenCalled();
      expect(await events("card_changed")).toHaveLength(1);

      // A reloaded callback gets the same key back and changes nothing.
      expect(await confirm()).toMatchObject({ ok: true, cardChanged: true });
      expect((await subscription(subId)).toss_billing_key).toBe("new-key");
      expect(toss.deleteBillingKey).toHaveBeenCalledTimes(1);
      expect(await events("card_changed")).toHaveLength(1);
    });

    test("a renewal failing on the old card is retried on the new one right away", async () => {
      const periodEnd = new Date(Date.now() - DAY);
      const { userId, subId, prepared, confirm } = await running({
        status: "active",
        billingKey: "old-key",
        currentPeriodEnd: periodEnd,
        nextBillingAt: periodEnd,
        failedChargeCount: 1,
      });
      toss.chargeBillingKey.mockImplementation(async (params) =>
        tossPayment(params.orderId, params.amount),
      );

      expect(await confirm()).toMatchObject({ ok: true, cardChanged: true });

      expect(toss.chargeBillingKey).toHaveBeenCalledTimes(1);
      expect(toss.chargeBillingKey.mock.calls[0][0]).toMatchObject({
        billingKey: "new-key",
        customerKey: prepared.customerKey,
      });
      const sub = await subscription(subId);
      expect(sub.status).toBe("active");
      expect(sub.failed_charge_count).toBe(0);
      expect((await supporterUntil(userId))! > new Date()).toBe(true);
    });

    test("an order the old card declined is retried on the new card, not counted", async () => {
      const periodEnd = new Date(Date.now() - DAY);
      const { subId, confirm } = await running({
        status: "active",
        billingKey: "old-key",
        currentPeriodEnd: periodEnd,
        nextBillingAt: periodEnd,
        failedChargeCount: 1,
      });
      // The reconciler learned Toss declined this try's order on the old card.
      const baseKey = `subscription:${subId}:${periodEnd.toISOString()}:2`;
      const sub0 = await subscription(subId);
      await db
        .insertInto("payments")
        .values({
          user_id: sub0.user_id,
          subscription_id: subId,
          attempt_key: baseKey,
          order_id: "declined-on-old-card",
          amount: 1000,
          status: "aborted",
        })
        .execute();
      toss.chargeBillingKey.mockImplementation(async (params) =>
        tossPayment(params.orderId, params.amount),
      );

      expect(await confirm()).toMatchObject({ ok: true, cardChanged: true });

      expect(toss.chargeBillingKey).toHaveBeenCalledTimes(1);
      expect(toss.chargeBillingKey.mock.calls[0][0]).toMatchObject({
        billingKey: "new-key",
      });
      const retried = await db
        .selectFrom("payments")
        .select(["attempt_key", "status"])
        .where("subscription_id", "=", subId)
        .where("attempt_key", "=", `${baseKey}:r1`)
        .executeTakeFirstOrThrow();
      expect(retried.status).toBe("done");
      const sub = await subscription(subId);
      expect(sub.status).toBe("active");
      expect(sub.failed_charge_count).toBe(0);
    });

    test("a card change that settles a paid renewal still swaps the card", async () => {
      const periodEnd = new Date(Date.now() - DAY);
      const { subId, confirm } = await running({
        status: "active",
        billingKey: "old-key",
        currentPeriodEnd: periodEnd,
        nextBillingAt: periodEnd,
      });
      // A renewal left unresolved while the supporter was in the card window,
      // which Toss in fact approved.
      const sub0 = await subscription(subId);
      await makePendingPayment({
        userId: sub0.user_id,
        subscriptionId: subId,
        attemptKey: `subscription:${subId}:${periodEnd.toISOString()}:1`,
        orderId: "paid-meanwhile",
        amount: 1000,
      });
      toss.getPaymentByOrderId.mockImplementation(async (orderId) => {
        if (orderId === "paid-meanwhile") {
          return tossPayment("paid-meanwhile", 1000);
        }
        throw new toss.TossApiError("not found", 404);
      });

      expect(await confirm()).toMatchObject({ ok: true, cardChanged: true });

      const sub = await subscription(subId);
      expect(sub.toss_billing_key).toBe("new-key");
      expect(sub.charging_started_at).toBeNull();
      expect(new Date(sub.current_period_end!) > new Date()).toBe(true);
      expect(toss.deleteBillingKey).toHaveBeenCalledWith("old-key");
      expect(toss.deleteBillingKey).not.toHaveBeenCalledWith("new-key");
    });

    test("a card change waits for a renewal charge in flight", async () => {
      const { subId, confirm } = await running({
        status: "active",
        billingKey: "old-key",
        nextBillingAt: new Date(Date.now() + 10 * DAY),
      });
      await db
        .updateTable("subscriptions")
        .set({ charging_started_at: new Date() })
        .where("id", "=", subId)
        .execute();

      expect(await confirm()).toMatchObject({ ok: false, status: 409 });
      expect(toss.issueBillingKey).not.toHaveBeenCalled();
      expect((await subscription(subId)).toss_billing_key).toBe("old-key");
    });

    test("a card change waits until an unsettled charge is known", async () => {
      const userId = await makeUser(new Date(Date.now() + 10 * DAY));
      const subId = await makeSubscription(userId, {
        status: "active",
        billingKey: "old-key",
      });
      await makePendingPayment({
        userId,
        subscriptionId: subId,
        attemptKey: `subscription:${subId}:x:1`,
        orderId: "unsettled",
        amount: 1000,
      });

      expect(await prepareCardChange({ userId })).toMatchObject({
        ok: false,
        status: 409,
      });
      expect((await subscription(subId)).card_registration_id).toBeNull();
    });

    test("a card change that lost to a cancel discards the new key", async () => {
      const { subId, confirm } = await running({
        status: "scheduled",
        billingKey: "old-key",
        nextBillingAt: new Date(Date.now() + 10 * DAY),
      });
      toss.issueBillingKey.mockImplementation(async () => {
        await db
          .updateTable("subscriptions")
          .set({ status: "canceled" })
          .where("id", "=", subId)
          .execute();
        return { billingKey: "new-key", customerKey: "unused" };
      });

      expect(await confirm()).toMatchObject({ ok: false, status: 409 });
      expect((await subscription(subId)).toss_billing_key).toBe("old-key");
      expect(toss.deleteBillingKey).toHaveBeenCalledWith("new-key");
    });

    test("only a running subscription can change its card", async () => {
      const userId = await makeUser();
      await makeSubscription(userId, { status: "past_due" });
      expect(await prepareCardChange({ userId })).toMatchObject({
        ok: false,
        status: 409,
      });
    });
  });

  describe("abandoned signups", () => {
    async function abandoned(lease: Date | null) {
      const userId = await makeUser();
      const subId = await makeSubscription(userId, {
        status: "incomplete",
        billingKey: "signup-key",
      });
      await db
        .updateTable("subscriptions")
        .set({ charging_started_at: lease })
        .where("id", "=", subId)
        .execute();
      const paymentId = await makePendingPayment({
        userId,
        subscriptionId: subId,
        attemptKey: `subscription_initial:${subId}:1`,
        orderId: `initial-${subId}`,
        amount: 1000,
      });
      await db
        .updateTable("payments")
        .set({ created_at: new Date(Date.now() - DAY) })
        .where("id", "=", paymentId)
        .execute();
      return { subId, paymentId };
    }

    test("a first charge Toss never saw retires the signup's key", async () => {
      const { subId, paymentId } = await abandoned(null);

      expect(await reconcilePayment(paymentId)).toEqual({ state: "expired" });

      expect((await subscription(subId)).toss_billing_key).toBeNull();
      expect(toss.deleteBillingKey).toHaveBeenCalledWith("signup-key");
    });

    test("a first charge Toss declined retires the signup's key", async () => {
      const { subId, paymentId } = await abandoned(null);
      toss.getPaymentByOrderId.mockResolvedValue(
        tossPayment(`initial-${subId}`, 1000, { status: "ABORTED" }),
      );

      await reconcilePayment(paymentId);

      expect((await subscription(subId)).toss_billing_key).toBeNull();
    });

    test("a signup still confirming keeps its key and its order", async () => {
      const { subId, paymentId } = await abandoned(new Date());

      // The confirm holding the lease may be charging this very order, which
      // Toss has not recorded yet.
      expect(await reconcilePayment(paymentId)).toEqual({ state: "pending" });

      expect((await subscription(subId)).toss_billing_key).toBe("signup-key");
    });

    test("the lease's own holder can expire an order Toss never saw", async () => {
      const lease = new Date();
      const { paymentId } = await abandoned(lease);

      expect(await reconcilePayment(paymentId, { leaseHeldAt: lease })).toEqual(
        { state: "expired" },
      );
    });

    test("an abandoned lease does not keep an order from expiring", async () => {
      const { paymentId } = await abandoned(new Date(Date.now() - DAY));

      expect(await reconcilePayment(paymentId)).toEqual({ state: "expired" });
    });
  });

  describe("renewal runs", () => {
    test("every due subscription is charged, however many there are", async () => {
      const periodEnd = new Date(Date.now() - 60 * 1000);
      const subIds: string[] = [];
      for (let i = 0; i < 23; i++) {
        const userId = await makeUser(periodEnd);
        subIds.push(
          await makeSubscription(userId, {
            status: "active",
            currentPeriodEnd: periodEnd,
            nextBillingAt: periodEnd,
          }),
        );
      }
      // Every third one fails ambiguously and must not be retried this run.
      let calls = 0;
      toss.chargeBillingKey.mockImplementation(async (params) => {
        calls += 1;
        if (calls % 3 === 0) throw new toss.TossApiError("server error", 500);
        return tossPayment(params.orderId, params.amount);
      });

      await chargeDueSubscriptions();

      expect(toss.chargeBillingKey).toHaveBeenCalledTimes(23);
      const charged = new Set(
        toss.chargeBillingKey.mock.calls.map(([params]) => params.customerKey),
      );
      expect(charged.size).toBe(23);
    });

    test("an unresolved charge past the grace period is past due", async () => {
      const periodEnd = new Date(Date.now() - 10 * DAY);
      const userId = await makeUser(periodEnd);
      const subId = await makeSubscription(userId, {
        status: "active",
        currentPeriodEnd: periodEnd,
        nextBillingAt: periodEnd,
      });
      toss.chargeBillingKey.mockRejectedValue(
        new toss.TossApiError("server error", 500),
      );

      await chargeDueSubscriptions();

      const sub = await subscription(subId);
      expect(sub.status).toBe("past_due");
      // Not a counted failure: the order may yet turn out paid.
      expect(sub.failed_charge_count).toBe(0);
    });

    test("an unresolved charge inside the grace period stays active", async () => {
      const periodEnd = new Date(Date.now() - 60 * 1000);
      const userId = await makeUser(periodEnd);
      const subId = await makeSubscription(userId, {
        status: "active",
        currentPeriodEnd: periodEnd,
        nextBillingAt: periodEnd,
      });
      toss.chargeBillingKey.mockRejectedValue(
        new toss.TossApiError("server error", 500),
      );

      await chargeDueSubscriptions();

      expect((await subscription(subId)).status).toBe("active");
    });
  });

  describe("past due mail", () => {
    async function dueSince(periodEnd: Date, failedChargeCount = 0) {
      const userId = await makeUser(periodEnd);
      const subId = await makeSubscription(userId, {
        status: "active",
        currentPeriodEnd: periodEnd,
        nextBillingAt: periodEnd,
        failedChargeCount,
        graceNoticeSentAt: failedChargeCount > 0 ? new Date() : null,
      });
      return subId;
    }

    test("spent retries inside the grace period say when features end", async () => {
      const periodEnd = new Date(Date.now() - 60 * 1000);
      const subId = await dueSince(periodEnd, MAX_PAYMENT_RETRY_ATTEMPTS - 1);
      toss.chargeBillingKey.mockRejectedValue(
        new toss.TossApiError("card declined", 400),
      );

      await chargeDueSubscriptions();
      await chargeDueSubscriptions();

      expect((await subscription(subId)).status).toBe("past_due");
      expect(email.sendSubscriptionPastDueEmail).toHaveBeenCalledTimes(1);
      expect(email.sendSubscriptionPastDueEmail).toHaveBeenCalledWith(
        expect.objectContaining({
          email: expect.stringMatching(/@example\.com$/),
          amount: 1000,
          reason: "declined",
          accessEndsAt: addPaymentGrace(periodEnd),
        }),
      );
    });

    test("a decline after the grace period says features have ended", async () => {
      await dueSince(new Date(Date.now() - 10 * DAY));
      toss.chargeBillingKey.mockRejectedValue(
        new toss.TossApiError("card declined", 400),
      );

      await chargeDueSubscriptions();

      expect(email.sendSubscriptionPastDueEmail).toHaveBeenCalledWith(
        // One decline, not "several tries": the grace period had already
        // ended.
        expect.objectContaining({
          reason: "declined",
          declinedAttempts: 1,
          accessEndsAt: null,
        }),
      );
    });

    test("an unresolved charge past the grace period is mailed as such", async () => {
      await dueSince(new Date(Date.now() - 10 * DAY));
      toss.chargeBillingKey.mockRejectedValue(
        new toss.TossApiError("server error", 500),
      );

      await chargeDueSubscriptions();

      expect(email.sendSubscriptionPastDueEmail).toHaveBeenCalledTimes(1);
      expect(email.sendSubscriptionPastDueEmail).toHaveBeenCalledWith(
        expect.objectContaining({ reason: "unresolved", accessEndsAt: null }),
      );
    });

    test("a decline with retries left is not mailed as past due", async () => {
      await dueSince(new Date(Date.now() - 60 * 1000));
      toss.chargeBillingKey.mockRejectedValue(
        new toss.TossApiError("card declined", 400),
      );

      await chargeDueSubscriptions();

      expect(email.sendSubscriptionPaymentGraceEmail).toHaveBeenCalledTimes(1);
      expect(email.sendSubscriptionPastDueEmail).not.toHaveBeenCalled();
    });
  });

  describe("settled orders", () => {
    test("an order settled elsewhere is not granted again", async () => {
      const userId = await makeUser();
      const paymentId = await makePendingPayment({
        userId,
        subscriptionId: null,
        attemptKey: "one_time:1:expired-order",
        orderId: "expired-order",
        amount: 12000,
      });
      await db
        .updateTable("payments")
        .set({ status: "expired" })
        .where("id", "=", paymentId)
        .execute();

      await expect(
        applyOneTimePayment({
          userId,
          amount: 12000,
          years: 1,
          payment: tossPayment("expired-order", 12000),
          paymentId,
        }),
      ).rejects.toThrow("not pending");
      expect(await supporterUntil(userId)).toBeNull();
    });
  });

  describe("billing key deletion retries", () => {
    test("a key Toss keeps refusing is retried less and less often", async () => {
      const lastAttempt = new Date();
      await db
        .insertInto("retired_billing_keys")
        .values({
          billing_key: "stubborn",
          attempts: 3,
          last_attempted_at: lastAttempt,
        })
        .execute();
      const at = (hours: number) =>
        new Date(lastAttempt.getTime() + hours * 60 * 60 * 1000);

      // Third failure: the next try waits four hours, not one.
      await deleteRetiredBillingKeys(at(2));
      expect(toss.deleteBillingKey).not.toHaveBeenCalled();
      await deleteRetiredBillingKeys(at(4.1));
      expect(toss.deleteBillingKey).toHaveBeenCalledWith("stubborn");
    });

    test("the wait never grows past a day", async () => {
      const lastAttempt = new Date();
      await db
        .insertInto("retired_billing_keys")
        .values({
          billing_key: "very-stubborn",
          attempts: 40,
          last_attempted_at: lastAttempt,
        })
        .execute();

      await deleteRetiredBillingKeys(
        new Date(lastAttempt.getTime() + DAY + 60 * 1000),
      );
      expect(toss.deleteBillingKey).toHaveBeenCalledWith("very-stubborn");
    });
  });

  describe("the refund sweep", () => {
    // A paid payment `ageDays` old, last checked `checkedDaysAgo` ago.
    async function paid(
      ageDays: number,
      checkedDaysAgo: number | null,
      orderId = `paid-${ageDays}-${checkedDaysAgo}`,
    ) {
      const userId = await makeUser();
      const paymentId = await makePendingPayment({
        userId,
        subscriptionId: null,
        attemptKey: `one_time:1:${orderId}`,
        orderId,
        amount: 12000,
      });
      const paidAt = new Date(Date.now() - ageDays * DAY);
      await db
        .updateTable("payments")
        .set({
          status: "done",
          paid_at: paidAt,
          created_at: paidAt,
          toss_payment_key: `pk-${orderId}`,
          last_reconciled_at:
            checkedDaysAgo === null
              ? null
              : new Date(Date.now() - checkedDaysAgo * DAY),
        })
        .where("id", "=", paymentId)
        .execute();
      return orderId;
    }

    function checkedOrders() {
      return toss.getPaymentByOrderId.mock.calls.map(([orderId]) => orderId);
    }

    beforeEach(() => {
      toss.getPaymentByOrderId.mockImplementation(async (orderId) =>
        tossPayment(orderId, 12000),
      );
    });

    test("checks each payment as often as its age calls for", async () => {
      const due = [
        await paid(3, 2), // refund window: daily
        await paid(3, null), // never checked
        await paid(100, 8), // within a year: weekly
        await paid(1000, 31), // up to Toss's five-year lookup: monthly
      ];
      const notDue = [
        await paid(3, 0.5),
        await paid(100, 3),
        await paid(1000, 10),
        // Older than Toss can look up.
        await paid(6 * 365, null),
      ];

      await syncPaymentRefunds();

      expect(checkedOrders().sort()).toEqual([...due].sort());
      expect(checkedOrders()).not.toEqual(expect.arrayContaining(notDue));
    });

    test("has no cap on how many payments one run checks", async () => {
      for (let i = 0; i < 1203; i++) {
        await paid(3, null, `many-${i}`);
      }

      const result = await syncPaymentRefunds();

      expect(result).toMatchObject({ checked: 1203, incomplete: false });
      expect(new Set(checkedOrders()).size).toBe(1203);
    });

    test("a run out of time leaves the rest first in line", async () => {
      const longest = await paid(200, 60);
      const shorter = await paid(200, 20);
      const recent = await paid(3, 2);

      expect(await syncPaymentRefunds({ budgetMs: 0 })).toMatchObject({
        checked: 0,
        incomplete: true,
      });

      // Most overdue first.
      toss.getPaymentByOrderId.mockClear();
      await syncPaymentRefunds();
      expect(checkedOrders()).toEqual([longest, shorter, recent]);
    });

    test("a payment whose check fails is not retried in the same run", async () => {
      const orderId = await paid(3, null);
      toss.getPaymentByOrderId.mockRejectedValue(
        new toss.TossApiError("server error", 500),
      );

      expect(await syncPaymentRefunds()).toMatchObject({
        checked: 1,
        failed: 1,
      });
      expect(checkedOrders()).toEqual([orderId]);
    });

    test("finds a refund made in the Toss dashboard", async () => {
      const orderId = await paid(30, 8);
      toss.getPaymentByOrderId.mockResolvedValue(
        tossPayment(orderId, 12000, {
          status: "CANCELED",
          cancels: [
            { cancelAmount: 12000, canceledAt: new Date().toISOString() },
          ],
        }),
      );

      expect(await syncPaymentRefunds()).toMatchObject({ refunded: 1 });
      const [row] = await db
        .selectFrom("payments")
        .select(["status", "refunded_amount"])
        .where("order_id", "=", orderId)
        .execute();
      expect(row).toEqual({ status: "canceled", refunded_amount: 12000 });
    });
  });

  describe("the billing lab", () => {
    const keys = {
      billing: process.env.TOSS_BILLING_SECRET_KEY,
      payment: process.env.TOSS_PAYMENT_SECRET_KEY,
    };
    beforeEach(() => {
      process.env.TOSS_BILLING_SECRET_KEY = "test_sk_billing";
      process.env.TOSS_PAYMENT_SECRET_KEY = "test_sk_payment";
    });
    afterAll(() => {
      for (const [name, value] of [
        ["TOSS_BILLING_SECRET_KEY", keys.billing],
        ["TOSS_PAYMENT_SECRET_KEY", keys.payment],
      ] as const) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    });

    async function activeSubscription() {
      const periodEnd = new Date(Date.now() + 20 * DAY);
      const userId = await makeUser(periodEnd);
      const subId = await makeSubscription(userId, {
        status: "active",
        billingKey: "lab-key-0001",
        currentPeriodEnd: periodEnd,
        nextBillingAt: periodEnd,
      });
      return { userId, subId, periodEnd };
    }

    test("refuses to run with a live key", async () => {
      process.env.TOSS_BILLING_SECRET_KEY = "live_sk_billing";
      const { subId } = await activeSubscription();

      await expect(
        runLabAction({ action: "charge", subscriptionId: subId }),
      ).rejects.toThrow("테스트 키");
      expect(toss.chargeBillingKey).not.toHaveBeenCalled();
    });

    test("charges now through the renewal code and shows what changed", async () => {
      const { subId, periodEnd } = await activeSubscription();
      toss.chargeBillingKey.mockImplementation(async (params) =>
        tossPayment(params.orderId, params.amount),
      );

      const result = await runLabAction({
        action: "charge",
        subscriptionId: subId,
      });

      expect(result.ok).toBe(true);
      expect(result.before!.payments).toHaveLength(0);
      expect(result.after!.payments).toEqual([
        expect.objectContaining({ status: "done", amount: 1000 }),
      ]);
      // Renewing early stacks on the period still running.
      expect(result.after!.subscription!.current_period_start).toBe(
        periodEnd.toISOString(),
      );
      // The key is shown masked, never whole.
      expect(result.after!.subscription!.billing_key).toBe("lab-••••0001");
      expect(JSON.stringify(result)).not.toContain("lab-key-0001");
    });

    test("a forced decline is counted like the cron counts it", async () => {
      const { subId } = await activeSubscription();
      toss.chargeBillingKey.mockRejectedValue(
        new toss.TossApiError("한도초과", 403, "REJECT_CARD_PAYMENT"),
      );

      const result = await runLabAction({
        action: "charge",
        subscriptionId: subId,
        testCode: "REJECT_CARD_PAYMENT",
      });

      expect(result.after!.subscription).toMatchObject({
        status: "active",
        failed_charge_count: 1,
      });
      expect(result.after!.payments[0]).toMatchObject({ status: "failed" });
    });

    test("moving past the grace period lets a decline end in past_due", async () => {
      const { subId } = await activeSubscription();
      await runLabAction({
        action: "advance",
        subscriptionId: subId,
        to: "past_grace",
      });
      toss.chargeBillingKey.mockRejectedValue(
        new toss.TossApiError("한도초과", 403, "REJECT_CARD_PAYMENT"),
      );

      const result = await runLabAction({
        action: "charge",
        subscriptionId: subId,
      });

      expect(result.after!.subscription!.status).toBe("past_due");
    });

    test("a deleted billing key arrives as a webhook and cancels", async () => {
      const { subId } = await activeSubscription();
      toss.deleteBillingKey
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(
          new toss.TossApiError("없음", 404, "NOT_FOUND_BILLING"),
        );

      const result = await runLabAction({
        action: "billing-deleted",
        subscriptionId: subId,
      });

      expect(result.message).toContain("HTTP 404 NOT_FOUND_BILLING");
      expect(result.after!.subscription).toMatchObject({
        status: "canceled",
        billing_key: null,
      });
      expect(result.after!.retiredKeys).toEqual([]);
    });
  });

  describe("payment events", () => {
    function events() {
      return db
        .selectFrom("payment_events")
        .select(["kind", "summary", "emailed_at", "created_at"])
        .orderBy("id")
        .execute();
    }

    async function dueSubscription() {
      const periodEnd = new Date(Date.now() - 60 * 1000);
      const userId = await makeUser(periodEnd);
      const subId = await makeSubscription(userId, {
        status: "active",
        currentPeriodEnd: periodEnd,
        nextBillingAt: periodEnd,
      });
      return { userId, subId };
    }

    test("a renewal records one success", async () => {
      await dueSubscription();
      toss.chargeBillingKey.mockImplementation(async (params) =>
        tossPayment(params.orderId, params.amount),
      );

      await chargeDueSubscriptions();

      expect(await events()).toEqual([
        expect.objectContaining({
          kind: "charge_succeeded",
          summary: expect.stringContaining("정기 결제 1,000원 (월간)"),
        }),
      ]);
    });

    test("a decline that ends the retries records the failure and past_due", async () => {
      const { subId } = await dueSubscription();
      await db
        .updateTable("subscriptions")
        .set({ failed_charge_count: 3 })
        .where("id", "=", subId)
        .execute();
      toss.chargeBillingKey.mockRejectedValue(
        new toss.TossApiError("한도초과", 403, "REJECT_CARD_PAYMENT"),
      );

      await chargeDueSubscriptions();

      expect((await events()).map((event) => event.kind)).toEqual([
        "charge_failed",
        "past_due",
      ]);
      expect((await events())[0].summary).toContain("(4/4회): 한도초과");
    });

    test("a refund is recorded once, however often it is reconciled", async () => {
      const userId = await makeUser(new Date(Date.now() + 300 * DAY));
      const paymentId = await makePendingPayment({
        userId,
        subscriptionId: null,
        attemptKey: "one_time:1:refund-event",
        orderId: "refund-event",
        amount: 12000,
      });
      await db
        .updateTable("payments")
        .set({
          status: "done",
          paid_at: new Date(),
          period_start: new Date(),
          period_end: new Date(Date.now() + 300 * DAY),
        })
        .where("id", "=", paymentId)
        .execute();
      toss.getPaymentByOrderId.mockResolvedValue(
        tossPayment("refund-event", 12000, {
          status: "CANCELED",
          cancels: [{ cancelAmount: 12000 }],
        }),
      );

      await reconcilePayment(paymentId);
      await reconcilePayment(paymentId);

      expect((await events()).map((event) => event.kind)).toEqual(["refunded"]);
    });

    test("BILLING_DELETED is stored as a delivery and recorded as an event", async () => {
      process.env.TOSS_BILLING_SECRET_KEY = "test_sk_billing";
      process.env.TOSS_PAYMENT_SECRET_KEY = "test_sk_payment";
      const userId = await makeUser(new Date(Date.now() + 10 * DAY));
      const subId = await makeSubscription(userId, {
        status: "active",
        billingKey: "event-key-0001",
      });

      await runLabAction({ action: "billing-deleted", subscriptionId: subId });

      expect((await events()).map((event) => event.kind)).toEqual([
        "billing_key_deleted",
      ]);
      const [delivery] = await db
        .selectFrom("toss_webhook_deliveries")
        .selectAll()
        .execute();
      expect(delivery).toMatchObject({
        event_type: "BILLING_DELETED",
        subject: "even••••0001",
        http_status: 200,
        outcome: `canceled subscription ${subId}`,
      });
      expect(delivery.payload).not.toContain("event-key-0001");
    });

    describe("the operator digest", () => {
      async function eventAt(secondsAgo: number, summary: string) {
        await db
          .insertInto("payment_events")
          .values({
            kind: "charge_succeeded",
            summary,
            created_at: new Date(Date.now() - secondsAgo * 1000),
          })
          .execute();
      }

      test("is not sent outside production", async () => {
        await eventAt(600, "a");
        expect(await sendPaymentEventDigest({ enabled: false })).toEqual({
          state: "disabled",
        });
        expect(email.sendPaymentEventDigestEmail).not.toHaveBeenCalled();
      });

      test("waits while events are still arriving", async () => {
        await eventAt(300, "first");
        await eventAt(30, "second");

        expect(await sendPaymentEventDigest({ enabled: true })).toEqual({
          state: "waiting",
          pending: 2,
        });
        expect(email.sendPaymentEventDigestEmail).not.toHaveBeenCalled();
      });

      test("merges everything pending into one email, once", async () => {
        await eventAt(400, "first");
        await eventAt(300, "second");
        await eventAt(200, "third");

        expect(await sendPaymentEventDigest({ enabled: true })).toEqual({
          state: "sent",
          events: 3,
        });
        expect(email.sendPaymentEventDigestEmail).toHaveBeenCalledTimes(1);
        const [message] = email.sendPaymentEventDigestEmail.mock.calls[0];
        expect(message.to).toBe("hello@naru.pub");
        expect(message.subject).toBe("[나루 결제] 3건: 결제 완료 3");
        expect(message.events.map((event) => event.summary)).toEqual([
          "first",
          "second",
          "third",
        ]);

        expect(await sendPaymentEventDigest({ enabled: true })).toEqual({
          state: "idle",
        });
        expect(email.sendPaymentEventDigestEmail).toHaveBeenCalledTimes(1);
      });

      test("does not hold events back forever while they keep coming", async () => {
        await eventAt(20 * 60, "long ago");
        await eventAt(10, "just now");

        expect(await sendPaymentEventDigest({ enabled: true })).toEqual({
          state: "sent",
          events: 2,
        });
      });

      test("a failed send keeps the events for the next run", async () => {
        await eventAt(300, "kept");
        email.sendPaymentEventDigestEmail.mockRejectedValueOnce(
          new Error("resend down"),
        );

        await expect(sendPaymentEventDigest({ enabled: true })).rejects.toThrow(
          "resend down",
        );
        expect((await events())[0].emailed_at).toBeNull();
        expect(await sendPaymentEventDigest({ enabled: true })).toEqual({
          state: "sent",
          events: 1,
        });
      });
    });
  });

  // The /admin overview counts with these conditions and its detail pages
  // list with them, so they must pick exactly the right rows.
  describe("admin card definitions", () => {
    async function payment(
      orderId: string,
      values: {
        status: string;
        paidDaysAgo?: number;
        createdDaysAgo?: number;
        refundedDaysAgo?: number;
        error?: string;
      },
    ) {
      const userId = await makeUser();
      const id = await makePendingPayment({
        userId,
        subscriptionId: null,
        attemptKey: `one_time:1:${orderId}`,
        orderId,
        amount: 12000,
      });
      const ago = (days?: number) =>
        days === undefined ? null : new Date(Date.now() - days * DAY);
      await db
        .updateTable("payments")
        .set({
          status: values.status,
          paid_at: ago(values.paidDaysAgo),
          created_at: ago(values.createdDaysAgo ?? 0)!,
          refunded_amount: values.refundedDaysAgo === undefined ? 0 : 12000,
          refunded_at: ago(values.refundedDaysAgo),
          reconciliation_error: values.error ?? null,
        })
        .where("id", "=", id)
        .execute();
    }

    test("each payment filter selects exactly its rows", async () => {
      await payment("paid-recent", { status: "done", paidDaysAgo: 3 });
      await payment("paid-old", { status: "done", paidDaysAgo: 40 });
      await payment("paid-then-refunded", {
        status: "canceled",
        paidDaysAgo: 10,
        refundedDaysAgo: 2,
      });
      await payment("refunded-long-ago", {
        status: "canceled",
        paidDaysAgo: 90,
        refundedDaysAgo: 60,
      });
      await payment("waiting", { status: "pending" });
      await payment("waiting-broken", { status: "pending", error: "boom" });
      await payment("done-broken", {
        status: "done",
        paidDaysAgo: 50,
        error: "boom",
      });
      await payment("declined-recent", {
        status: "aborted",
        createdDaysAgo: 2,
      });
      await payment("failed-old", { status: "failed", createdDaysAgo: 20 });
      await payment("abandoned", { status: "expired", createdDaysAgo: 1 });

      const now = new Date();
      const select = async (key: keyof typeof PAYMENT_FILTERS) =>
        (
          await db
            .selectFrom("payments")
            .select("order_id")
            .where(PAYMENT_FILTERS[key].condition(now))
            .orderBy("order_id")
            .execute()
        ).map((row) => row.order_id);

      expect(await select("paid_30d")).toEqual([
        "paid-recent",
        "paid-then-refunded",
      ]);
      expect(await select("refunded_30d")).toEqual(["paid-then-refunded"]);
      expect(await select("pending")).toEqual(["waiting", "waiting-broken"]);
      expect(await select("errors")).toEqual(["done-broken", "waiting-broken"]);
      expect(await select("failed_7d")).toEqual(["declined-recent"]);
      expect(await select("orphaned")).toEqual([]);
    });

    test("the supporter count agrees with the entitlement rule", async () => {
      const comp = await makeUser(null);
      await db
        .updateTable("users")
        .set({ supporter_comp: true })
        .where("id", "=", comp)
        .execute();
      const users = [
        comp,
        await makeUser(new Date(Date.now() + 10 * DAY)), // paid
        await makeUser(new Date(Date.now() - 2 * DAY)), // in grace
        await makeUser(new Date(Date.now() - 10 * DAY)), // lapsed
        await makeUser(null), // never paid
      ];

      const counted = new Set(
        (
          await db
            .selectFrom("users")
            .select("id")
            .where(supporterCondition(new Date()))
            .execute()
        ).map((row) => row.id),
      );

      for (const userId of users) {
        const { isSupporter } = await getUserEntitlement(userId);
        expect(counted.has(userId)).toBe(isSupporter);
      }
      expect(counted.size).toBe(3);
    });
  });

  // Payment ids are UUIDv7: not guessable from one another, but in the order
  // they were made, which the billing code relies on (latest attempt first,
  // oldest event first).
  describe("payment ids", () => {
    const V7 =
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

    test("are UUIDv7, in the order rows are written", async () => {
      const userId = await makeUser();
      const subId = await makeSubscription(userId, { status: "active" });
      const ids: string[] = [];
      for (let i = 0; i < 20; i++) {
        ids.push(
          await makePendingPayment({
            userId,
            subscriptionId: subId,
            attemptKey: `subscription:${subId}:order:${i}`,
            orderId: `ordered-${i}`,
            amount: 1000,
          }),
        );
      }

      expect(subId).toMatch(V7);
      for (const id of ids) expect(id).toMatch(V7);
      expect([...ids].sort()).toEqual(ids);
    });

    test("events written in one transaction keep their order", async () => {
      await db.transaction().execute(async (trx) => {
        for (let i = 0; i < 10; i++) {
          await trx
            .insertInto("payment_events")
            .values({ kind: "charge_failed", summary: `event-${i}` })
            .execute();
        }
      });
      const rows = await db
        .selectFrom("payment_events")
        .select("summary")
        .orderBy("id")
        .execute();
      expect(rows.map((row) => row.summary)).toEqual(
        Array.from({ length: 10 }, (_, i) => `event-${i}`),
      );
    });
  });

  describe("second review", () => {
    async function oneTimeOrder(
      userId: string,
      opts: {
        orderId: string;
        status?: string;
        createdMinutesAgo?: number;
        paidMinutesAgo?: number;
      },
    ) {
      const row = await db
        .insertInto("payments")
        .values({
          user_id: userId,
          subscription_id: null,
          attempt_key: `one_time:1:${opts.orderId}`,
          order_id: opts.orderId,
          amount: 12000,
          status: opts.status ?? "pending",
          created_at: new Date(
            Date.now() - (opts.createdMinutesAgo ?? 5) * 60_000,
          ),
          paid_at:
            opts.paidMinutesAgo == null
              ? null
              : new Date(Date.now() - opts.paidMinutesAgo * 60_000),
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      return row.id;
    }

    async function setPlanStartedAt(subId: string, at: Date) {
      await db
        .updateTable("subscriptions")
        .set({ plan_started_at: at })
        .where("id", "=", subId)
        .execute();
    }

    function canceledAt(orderId: string, amount: number, at: Date) {
      return tossPayment(orderId, amount, {
        status: "CANCELED",
        cancels: [{ cancelAmount: amount, canceledAt: at.toISOString() }],
      });
    }

    describe("which plan a refund ends", () => {
      test("a refund seen late leaves a plan started after it", async () => {
        const userId = await makeUser();
        const paymentId = await oneTimeOrder(userId, {
          orderId: "late-refund",
          status: "done",
          paidMinutesAgo: 3 * 24 * 60,
        });
        const subId = await makeSubscription(userId, { status: "active" });
        await setPlanStartedAt(subId, new Date(Date.now() - DAY));
        toss.getPaymentByOrderId.mockResolvedValue(
          canceledAt("late-refund", 12000, new Date(Date.now() - 2 * DAY)),
        );

        expect(await reconcilePayment(paymentId)).toMatchObject({
          state: "refunded",
          subscriptionCanceled: false,
        });
        const sub = await subscription(subId);
        expect(sub.status).toBe("active");
        expect(sub.toss_billing_key).not.toBeNull();
      });

      test("a refund ends a plan that was running when it happened", async () => {
        const userId = await makeUser();
        const paymentId = await oneTimeOrder(userId, {
          orderId: "plan-older",
          status: "done",
          paidMinutesAgo: 60,
        });
        const subId = await makeSubscription(userId, { status: "active" });
        await setPlanStartedAt(subId, new Date(Date.now() - 2 * DAY));
        toss.getPaymentByOrderId.mockResolvedValue(
          canceledAt("plan-older", 12000, new Date()),
        );

        expect(await reconcilePayment(paymentId)).toMatchObject({
          subscriptionCanceled: true,
        });
        expect((await subscription(subId)).status).toBe("canceled");
      });

      test("an operator refund can keep the plan, even when the webhook gets there first", async () => {
        const userId = await makeUser();
        const paymentId = await oneTimeOrder(userId, {
          orderId: "keep-plan",
          status: "done",
          paidMinutesAgo: 60,
        });
        await db
          .updateTable("payments")
          .set({ toss_payment_key: "pk-keep-plan" })
          .where("id", "=", paymentId)
          .execute();
        const subId = await makeSubscription(userId, { status: "active" });
        toss.getPaymentByOrderId.mockResolvedValue(
          canceledAt("keep-plan", 12000, new Date()),
        );
        // Toss's webhook reconciles the cancel before the refund's own call
        // returns.
        toss.cancelPayment.mockImplementation(async () => {
          await reconcilePayment(paymentId);
          return canceledAt("keep-plan", 12000, new Date());
        });

        await expect(
          refundPayment({
            paymentId,
            overridePolicy: true,
            reason: "duplicate",
            keepPlan: true,
          }),
        ).resolves.toMatchObject({ subscriptionCanceled: false });
        const sub = await subscription(subId);
        expect(sub.status).toBe("active");
        expect(sub.toss_billing_key).not.toBeNull();
      });

      test("the plan's end is reported however the refund was first seen", async () => {
        const userId = await makeUser();
        const paymentId = await oneTimeOrder(userId, {
          orderId: "webhook-first",
          status: "done",
          paidMinutesAgo: 60,
        });
        await db
          .updateTable("payments")
          .set({ toss_payment_key: "pk-webhook-first" })
          .where("id", "=", paymentId)
          .execute();
        const subId = await makeSubscription(userId, { status: "active" });
        toss.getPaymentByOrderId.mockResolvedValue(
          canceledAt("webhook-first", 12000, new Date()),
        );
        toss.cancelPayment.mockImplementation(async () => {
          await reconcilePayment(paymentId);
          return canceledAt("webhook-first", 12000, new Date());
        });

        await expect(
          refundPayment({ paymentId, overridePolicy: false, reason: "test" }),
        ).resolves.toMatchObject({ subscriptionCanceled: true });
        expect((await subscription(subId)).status).toBe("canceled");
      });

      test("a cancel Toss accepted is a refund even when the lookup after it fails", async () => {
        const userId = await makeUser();
        const paymentId = await oneTimeOrder(userId, {
          orderId: "lookup-fails",
          status: "done",
          paidMinutesAgo: 60,
        });
        await db
          .updateTable("payments")
          .set({ toss_payment_key: "pk-lookup-fails" })
          .where("id", "=", paymentId)
          .execute();
        const subId = await makeSubscription(userId, { status: "active" });
        toss.cancelPayment.mockResolvedValue(
          canceledAt("lookup-fails", 12000, new Date()),
        );
        toss.getPaymentByOrderId.mockRejectedValue(
          new toss.TossApiError("bad gateway", 502),
        );

        await expect(
          refundPayment({ paymentId, overridePolicy: false, reason: "test" }),
        ).resolves.toMatchObject({ subscriptionCanceled: true });
        expect((await subscription(subId)).status).toBe("canceled");
      });

      test("a one-time order granted late leaves a plan started since", async () => {
        const userId = await makeUser();
        const paymentId = await oneTimeOrder(userId, {
          orderId: "old-one-time",
          createdMinutesAgo: 30 * 24 * 60,
        });
        const subId = await makeSubscription(userId, { status: "active" });
        await setPlanStartedAt(subId, new Date(Date.now() - 10 * DAY));
        const approvedAt = new Date(Date.now() - 30 * DAY);

        await applyOneTimePayment({
          userId,
          amount: 12000,
          years: 1,
          payment: tossPayment("old-one-time", 12000, {
            approvedAt: approvedAt.toISOString(),
          }),
          paymentId,
        });

        expect((await subscription(subId)).status).toBe("active");
        const row = await db
          .selectFrom("payments")
          .select("paid_at")
          .where("id", "=", paymentId)
          .executeTakeFirstOrThrow();
        expect(new Date(row.paid_at!)).toEqual(approvedAt);
      });
    });

    test("a refund recomputes supporter_until with a period granted meanwhile", async () => {
      const userId = await makeUser();
      const refundedId = await oneTimeOrder(userId, {
        orderId: "refunded-a",
        status: "done",
        paidMinutesAgo: 60,
      });
      const aEnd = new Date(Date.now() + 300 * DAY);
      await db
        .updateTable("payments")
        .set({ period_start: new Date(Date.now() - 60_000), period_end: aEnd })
        .where("id", "=", refundedId)
        .execute();
      await db
        .updateTable("users")
        .set({ supporter_until: aEnd })
        .where("id", "=", userId)
        .execute();
      toss.getPaymentByOrderId.mockResolvedValue(
        canceledAt("refunded-a", 12000, new Date()),
      );

      // A grant holding the user's lock while the refund runs.
      const bEnd = new Date(Date.now() + 30 * DAY);
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      let locked = false;
      const grant = db.transaction().execute(async (trx) => {
        await trx
          .selectFrom("users")
          .select("id")
          .where("id", "=", userId)
          .forUpdate()
          .execute();
        locked = true;
        await trx
          .insertInto("payments")
          .values({
            user_id: userId,
            subscription_id: null,
            attempt_key: "one_time:1:granted-b",
            order_id: "granted-b",
            amount: 12000,
            status: "done",
            paid_at: new Date(),
            period_start: new Date(),
            period_end: bEnd,
          })
          .execute();
        await trx
          .updateTable("users")
          .set({ supporter_until: bEnd })
          .where("id", "=", userId)
          .execute();
        await gate;
      });
      while (!locked) await new Promise((r) => setTimeout(r, 5));

      const refund = reconcilePayment(refundedId);
      await new Promise((r) => setTimeout(r, 100));
      release();
      await grant;
      await refund;

      expect(await supporterUntil(userId)).toEqual(bEnd);
    });

    describe("the charge lease", () => {
      test("ending a plan leaves the lease of a charge in flight", async () => {
        const userId = await makeUser();
        const paymentId = await oneTimeOrder(userId, {
          orderId: "lease-refund",
          status: "done",
          paidMinutesAgo: 60,
        });
        const subId = await makeSubscription(userId, { status: "active" });
        const lease = new Date();
        await db
          .updateTable("subscriptions")
          .set({ charging_started_at: lease })
          .where("id", "=", subId)
          .execute();
        toss.getPaymentByOrderId.mockResolvedValue(
          canceledAt("lease-refund", 12000, new Date()),
        );

        await reconcilePayment(paymentId);

        const sub = await subscription(subId);
        expect(sub.status).toBe("canceled");
        expect(new Date(sub.charging_started_at!)).toEqual(lease);
      });

      test("each subscription is charged on a lease taken just before", async () => {
        const periodEnd = new Date(Date.now() - 60_000);
        for (let i = 0; i < 2; i++) {
          const userId = await makeUser(periodEnd);
          await makeSubscription(userId, {
            status: "active",
            currentPeriodEnd: periodEnd,
            nextBillingAt: periodEnd,
          });
        }
        const leasesAtCharge: number[] = [];
        toss.chargeBillingKey.mockImplementation(async (params) => {
          const row = await db
            .selectFrom("subscriptions")
            .select("charging_started_at")
            .where("toss_billing_key", "=", params.billingKey)
            .executeTakeFirstOrThrow();
          leasesAtCharge.push(new Date(row.charging_started_at!).getTime());
          // The first charge is slow.
          await new Promise((r) => setTimeout(r, 50));
          return tossPayment(params.orderId, params.amount);
        });

        await chargeDueSubscriptions();

        expect(leasesAtCharge).toHaveLength(2);
        expect(leasesAtCharge[1] - leasesAtCharge[0]).toBeGreaterThanOrEqual(
          40,
        );
      });
    });

    test("a lifetime comp is never charged for a plan it still has", async () => {
      const periodEnd = new Date(Date.now() - 60_000);
      const userId = await makeUser(periodEnd);
      await db
        .updateTable("users")
        .set({ supporter_comp: true })
        .where("id", "=", userId)
        .execute();
      await makeSubscription(userId, {
        status: "active",
        currentPeriodEnd: periodEnd,
        nextBillingAt: periodEnd,
      });

      await chargeDueSubscriptions();

      expect(toss.chargeBillingKey).not.toHaveBeenCalled();
    });

    test("one subscription's error does not stop the renewal run", async () => {
      const periodEnd = new Date(Date.now() - 60_000);
      const brokenUser = await makeUser(periodEnd);
      const broken = await makeSubscription(brokenUser, {
        status: "active",
        currentPeriodEnd: periodEnd,
        nextBillingAt: new Date(periodEnd.getTime() - 1000),
      });
      // A row already holding the key this try would retry under makes the
      // attempt insert fail.
      const baseKey = `subscription:${broken}:${periodEnd.toISOString()}:1`;
      await db
        .insertInto("payments")
        .values({
          user_id: brokenUser,
          subscription_id: broken,
          attempt_key: `${baseKey}:r1`,
          order_id: "blocking-row",
          amount: 1000,
          status: "failed",
        })
        .execute();
      const fineUser = await makeUser(periodEnd);
      const fine = await makeSubscription(fineUser, {
        status: "active",
        currentPeriodEnd: periodEnd,
        nextBillingAt: periodEnd,
      });
      toss.chargeBillingKey.mockImplementation(async (params) =>
        tossPayment(params.orderId, params.amount),
      );

      await chargeDueSubscriptions();

      expect((await subscription(broken)).charging_started_at).toBeNull();
      expect((await supporterUntil(fineUser))! > periodEnd).toBe(true);
      expect((await subscription(fine)).status).toBe("active");
    });

    describe("one-time purchases", () => {
      function prepare(userId: string) {
        auth.validateRequest.mockResolvedValue({
          user: {
            id: userId,
            email: "payer@example.com",
            emailVerifiedAt: new Date(),
          },
          session: {},
        } as Awaited<ReturnType<typeof auth.validateRequest>>);
        return oneTimePrepareRoute(
          new NextRequest(
            "http://localhost/api/account/donation/one-time/prepare",
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ years: 1 }),
            },
          ),
        );
      }

      test("an order another one-time payment already covered is not approved", async () => {
        const userId = await makeUser();
        const staleId = await oneTimeOrder(userId, {
          orderId: "second-tab",
          createdMinutesAgo: 10,
        });
        await oneTimeOrder(userId, {
          orderId: "first-tab",
          status: "done",
          createdMinutesAgo: 9,
          paidMinutesAgo: 5,
        });
        toss.getPaymentByOrderId.mockResolvedValue(
          tossPayment("second-tab", 12000, { status: "IN_PROGRESS" }),
        );

        expect(await reconcilePayment(staleId)).toEqual({ state: "pending" });
        expect(toss.confirmPayment).not.toHaveBeenCalled();
      });

      test("prepare confirms an earlier authenticated order, then refuses a second year", async () => {
        const userId = await makeUser();
        await oneTimeOrder(userId, { orderId: "authenticated" });
        toss.getPaymentByOrderId.mockResolvedValue(
          tossPayment("authenticated", 12000, { status: "IN_PROGRESS" }),
        );
        toss.confirmPayment.mockResolvedValue(
          tossPayment("authenticated", 12000),
        );

        const response = await prepare(userId);

        expect(response.status).toBe(409);
        expect((await supporterUntil(userId))! > new Date()).toBe(true);
      });

      test("a closed payment window does not block another try", async () => {
        const userId = await makeUser();
        await oneTimeOrder(userId, { orderId: "window-closed" });
        toss.getPaymentByOrderId.mockRejectedValue(
          new toss.TossApiError("not found", 404),
        );

        const response = await prepare(userId);

        expect(response.status).toBe(200);
        // It was looked up, and found to be nothing Toss knows.
        expect(toss.getPaymentByOrderId).toHaveBeenCalledWith(
          "window-closed",
          "one-time",
        );
      });

      test("prepare waits for a signup charge that may yet succeed", async () => {
        const userId = await makeUser();
        const subId = await makeSubscription(userId, { status: "incomplete" });
        await makePendingPayment({
          userId,
          subscriptionId: subId,
          attemptKey: `subscription_initial:${subId}:1`,
          orderId: "signup-unknown",
          amount: 1000,
        });
        toss.getPaymentByOrderId.mockRejectedValue(
          new toss.TossApiError("bad gateway", 502),
        );

        const response = await prepare(userId);

        expect(response.status).toBe(409);
      });

      test("a one-time purchase ends a signup still waiting on its card", async () => {
        const userId = await makeUser();
        const subId = await makeSubscription(userId, {
          status: "incomplete",
          billingKey: "signup-key",
        });
        const paymentId = await oneTimeOrder(userId, { orderId: "switch" });

        await applyOneTimePayment({
          userId,
          amount: 12000,
          years: 1,
          payment: tossPayment("switch", 12000),
          paymentId,
        });

        const sub = await subscription(subId);
        expect(sub.status).toBe("switched_to_one_time");
        expect(sub.toss_billing_key).toBeNull();
        expect(toss.deleteBillingKey).toHaveBeenCalledWith("signup-key");
      });
    });

    describe("account deletion", () => {
      test("waits for a charge in flight", async () => {
        const userId = await makeUser();
        const subId = await makeSubscription(userId, { status: "active" });
        await db
          .updateTable("subscriptions")
          .set({ charging_started_at: new Date() })
          .where("id", "=", subId)
          .execute();

        expect(await settleChargesBeforeDeletion(userId)).toBe(false);
        await expect(
          db.transaction().execute((trx) => deleteUserRow(trx, userId)),
        ).rejects.toMatchObject({ name: "ChargeInFlightError" });
        expect(await supporterUntil(userId)).toBeNull();
        const still = await db
          .selectFrom("users")
          .select("id")
          .where("id", "=", userId)
          .executeTakeFirst();
        expect(still).toBeDefined();
      });

      test("waits for a renewal whose outcome is unknown", async () => {
        const userId = await makeUser();
        const subId = await makeSubscription(userId, { status: "active" });
        await makePendingPayment({
          userId,
          subscriptionId: subId,
          attemptKey: `subscription:${subId}:x:1`,
          orderId: "renewal-unknown",
          amount: 1000,
        });
        toss.getPaymentByOrderId.mockRejectedValue(
          new toss.TossApiError("bad gateway", 502),
        );

        expect(await settleChargesBeforeDeletion(userId)).toBe(false);
      });

      test("goes ahead when nothing is charging", async () => {
        const userId = await makeUser();
        await makeSubscription(userId, { status: "active" });

        expect(await settleChargesBeforeDeletion(userId)).toBe(true);
      });
    });
  });

  describe("third review", () => {
    function signedIn(userId: string) {
      auth.validateRequest.mockResolvedValue({
        user: {
          id: userId,
          email: "payer@example.com",
          emailVerifiedAt: new Date(),
          loginName: "payer",
        },
        session: {},
      } as Awaited<ReturnType<typeof auth.validateRequest>>);
    }

    function prepareOneTime(userId: string) {
      signedIn(userId);
      return oneTimePrepareRoute(
        new NextRequest(
          "http://localhost/api/account/donation/one-time/prepare",
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ years: 1 }),
          },
        ),
      );
    }

    async function pendingOneTime(userId: string, orderId: string) {
      return makePendingPayment({
        userId,
        subscriptionId: null,
        attemptKey: `one_time:1:${orderId}`,
        orderId,
        amount: 12000,
      });
    }

    async function holdLease(subId: string) {
      await db
        .updateTable("subscriptions")
        .set({ charging_started_at: new Date() })
        .where("id", "=", subId)
        .execute();
    }

    test("a queued key a subscription still holds is never deleted", async () => {
      const userId = await makeUser();
      const subId = await makeSubscription(userId, {
        status: "active",
        billingKey: "live-key",
      });
      await db
        .insertInto("retired_billing_keys")
        .values({ billing_key: "live-key" })
        .execute();

      await deleteRetiredBillingKeys();

      expect(toss.deleteBillingKey).not.toHaveBeenCalled();
      expect((await subscription(subId)).toss_billing_key).toBe("live-key");
      const queued = await db
        .selectFrom("retired_billing_keys")
        .select("id")
        .execute();
      expect(queued).toEqual([]);
      const events = await db
        .selectFrom("payment_events")
        .select("kind")
        .execute();
      expect(events).toEqual([{ kind: "key_deletion_stuck" }]);
    });

    test("a first charge Toss has not finished keeps the card", async () => {
      const userId = await makeUser();
      const prepared = await prepareSubscription({ userId, interval: "month" });
      if (!prepared.ok) throw new Error(prepared.message);
      toss.issueBillingKey.mockResolvedValue({
        billingKey: "fresh-key",
        customerKey: prepared.customerKey,
      });
      toss.chargeBillingKey.mockImplementation(async (params) =>
        tossPayment(params.orderId, params.amount, { status: "IN_PROGRESS" }),
      );

      expect(
        await confirmSubscription({
          userId,
          authKey: "auth",
          customerKey: prepared.customerKey,
          registrationId: prepared.registrationId,
        }),
      ).toMatchObject({ ok: false, status: 503 });

      const sub = await db
        .selectFrom("subscriptions")
        .select(["status", "toss_billing_key"])
        .where("user_id", "=", userId)
        .executeTakeFirstOrThrow();
      expect(sub).toEqual({
        status: "incomplete",
        toss_billing_key: "fresh-key",
      });
      expect(toss.deleteBillingKey).not.toHaveBeenCalled();
    });

    test("a signup waits for a one-time order still being approved", async () => {
      const userId = await makeUser();
      await pendingOneTime(userId, "being-approved");
      toss.getPaymentByOrderId.mockResolvedValue(
        tossPayment("being-approved", 12000, { status: "IN_PROGRESS" }),
      );
      toss.confirmPayment.mockRejectedValue(
        new toss.TossApiError("처리 중", 400, "ALREADY_PROCESSING_REQUEST"),
      );

      expect(
        await prepareSubscription({ userId, interval: "month" }),
      ).toMatchObject({ ok: false, status: 409 });
    });

    test("one-time prepare waits while a renewal is being charged", async () => {
      const userId = await makeUser();
      const subId = await makeSubscription(userId, { status: "active" });
      await holdLease(subId);

      expect((await prepareOneTime(userId)).status).toBe(409);
    });

    test("one-time prepare allows retries, but not a script's worth", async () => {
      const userId = await makeUser();
      for (let i = 1; i <= 9; i++) await pendingOneTime(userId, `try-${i}`);
      // A tenth order is still a person retrying.
      expect((await prepareOneTime(userId)).status).toBe(200);

      toss.getPaymentByOrderId.mockClear();
      expect((await prepareOneTime(userId)).status).toBe(429);
      expect(toss.getPaymentByOrderId).not.toHaveBeenCalled();
    });

    test("one-time confirm waits while a renewal is being charged", async () => {
      const userId = await makeUser();
      const subId = await makeSubscription(userId, { status: "active" });
      await holdLease(subId);
      await pendingOneTime(userId, "confirm-waits");
      signedIn(userId);

      const response = await oneTimeConfirmRoute(
        new NextRequest(
          "http://localhost/api/account/donation/one-time/confirm",
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              paymentKey: "pk-confirm-waits",
              orderId: "confirm-waits",
              amount: 12000,
            }),
          },
        ),
      );

      expect(response.status).toBe(503);
      expect(toss.confirmPayment).not.toHaveBeenCalled();
      expect((await subscription(subId)).status).toBe("active");
    });

    test("one-time confirm refuses an order another payment covered", async () => {
      const userId = await makeUser();
      await pendingOneTime(userId, "second-tab-route");
      await db
        .insertInto("payments")
        .values({
          user_id: userId,
          subscription_id: null,
          attempt_key: "one_time:1:first-tab-route",
          order_id: "first-tab-route",
          amount: 12000,
          status: "done",
          paid_at: new Date(Date.now() + 1000),
        })
        .execute();
      signedIn(userId);

      const response = await oneTimeConfirmRoute(
        new NextRequest(
          "http://localhost/api/account/donation/one-time/confirm",
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              paymentKey: "pk-second-tab-route",
              orderId: "second-tab-route",
              amount: 12000,
            }),
          },
        ),
      );

      expect(response.status).toBe(409);
      expect(toss.confirmPayment).not.toHaveBeenCalled();
    });

    test("a refund that leaves a plan running moves its next charge to the paid time left", async () => {
      const userId = await makeUser();
      const paymentId = await makePendingPayment({
        userId,
        subscriptionId: null,
        attemptKey: "one_time:1:prepaid",
        orderId: "prepaid",
        amount: 12000,
      });
      const prepaidEnd = new Date(Date.now() + 300 * DAY);
      await db
        .updateTable("payments")
        .set({
          status: "done",
          paid_at: new Date(Date.now() - 10 * DAY),
          period_start: new Date(Date.now() - 10 * DAY),
          period_end: prepaidEnd,
        })
        .where("id", "=", paymentId)
        .execute();
      await db
        .updateTable("users")
        .set({ supporter_until: prepaidEnd })
        .where("id", "=", userId)
        .execute();
      // Scheduled to start when the prepaid year ends, signed up after the
      // refund happened (which the ledger only now learns of).
      const subId = await makeSubscription(userId, {
        status: "scheduled",
        currentPeriodEnd: prepaidEnd,
        nextBillingAt: prepaidEnd,
        planStartedAt: new Date(Date.now() - DAY),
      });
      toss.getPaymentByOrderId.mockResolvedValue(
        tossPayment("prepaid", 12000, {
          status: "CANCELED",
          cancels: [
            {
              cancelAmount: 12000,
              canceledAt: new Date(Date.now() - 2 * DAY).toISOString(),
            },
          ],
        }),
      );

      await reconcilePayment(paymentId);

      const sub = await subscription(subId);
      expect(sub.status).toBe("scheduled");
      expect(new Date(sub.next_billing_at!).getTime()).toBeLessThanOrEqual(
        Date.now(),
      );
      expect(await supporterUntil(userId)).toBeNull();
    });

    test("deleting an account ends its plan before anything is deleted", async () => {
      const userId = await makeUser();
      const subId = await makeSubscription(userId, {
        status: "active",
        billingKey: "deleting-key",
      });

      expect(await settleChargesBeforeDeletion(userId)).toBe(true);

      const sub = await subscription(subId);
      expect(sub.status).toBe("canceled");
      expect(sub.next_billing_at).toBeNull();
      expect(sub.toss_billing_key).toBeNull();
      expect(toss.deleteBillingKey).toHaveBeenCalledWith("deleting-key");
    });

    test("a plan the reconciler paid meanwhile is not marked past due", async () => {
      const periodEnd = new Date(Date.now() - 10 * DAY);
      const userId = await makeUser(periodEnd);
      const subId = await makeSubscription(userId, {
        status: "active",
        currentPeriodEnd: periodEnd,
        nextBillingAt: periodEnd,
      });
      const paymentId = await makePendingPayment({
        userId,
        subscriptionId: subId,
        attemptKey: `subscription:${subId}:${periodEnd.toISOString()}:1`,
        orderId: "paid-elsewhere",
        amount: 1000,
      });
      // The renewal's lookup fails; the reconciler grants the same order at
      // that moment.
      toss.getPaymentByOrderId.mockImplementationOnce(async () => {
        await applySuccessfulCharge({
          subscriptionId: subId,
          userId,
          interval: "month",
          amount: 1000,
          from: new Date(),
          payment: tossPayment("paid-elsewhere", 1000),
          paymentId,
        });
        throw new toss.TossApiError("bad gateway", 502);
      });

      await chargeDueSubscriptions();

      expect((await subscription(subId)).status).toBe("active");
      expect(email.sendSubscriptionPastDueEmail).not.toHaveBeenCalled();
    });

    test("a signup's first charge declined by webhook retires its card", async () => {
      const userId = await makeUser();
      const subId = await makeSubscription(userId, {
        status: "incomplete",
        billingKey: "declined-signup-key",
      });
      const before = await subscription(subId);
      await makePendingPayment({
        userId,
        subscriptionId: subId,
        attemptKey: `subscription_initial:${subId}:1`,
        orderId: "declined-by-webhook",
        amount: 1000,
      });
      toss.getPaymentByOrderId.mockResolvedValue(
        tossPayment("declined-by-webhook", 1000, { status: "ABORTED" }),
      );

      const response = await tossWebhook(
        new NextRequest("http://localhost/api/webhooks/toss", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            eventType: "PAYMENT_STATUS_CHANGED",
            data: { orderId: "declined-by-webhook", status: "ABORTED" },
          }),
        }),
      );

      expect(response.status).toBe(200);
      const sub = await subscription(subId);
      expect(sub.toss_billing_key).toBeNull();
      expect(sub.card_registration_id).not.toBe(before.card_registration_id);
      // Deleted at Toss by the cron, not inside the webhook.
      expect(toss.deleteBillingKey).not.toHaveBeenCalled();
      const queued = await db
        .selectFrom("retired_billing_keys")
        .select("billing_key")
        .execute();
      expect(queued).toEqual([{ billing_key: "declined-signup-key" }]);
    });
  });
});
