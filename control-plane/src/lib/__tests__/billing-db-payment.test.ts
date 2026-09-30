/** @jest-environment node */
import {
  afterAll,
  beforeEach,
  describe,
  expect,
  jest,
  test,
} from "@jest/globals";
import { randomUUID } from "crypto";
import type { TossPaymentResult } from "@/lib/toss";

jest.mock("@/lib/toss", () => {
  const actual = jest.requireActual<typeof import("@/lib/toss")>("@/lib/toss");
  return {
    ...actual,
    cancelPayment: jest.fn(),
    chargeBillingKey: jest.fn(),
    deleteBillingKey: jest.fn(),
    getPaymentByOrderId: jest.fn(),
  };
});
jest.mock("@/lib/email", () => ({
  sendSubscriptionPaymentGraceEmail: jest.fn(async () => {}),
}));

// Required after the mocks: this transform does not hoist jest.mock above
// imports.
const { sql } = require("kysely") as typeof import("kysely");
const { db } = require("@/lib/database") as typeof import("@/lib/database");
const toss = require("@/lib/toss") as jest.Mocked<typeof import("@/lib/toss")>;
const email = require("@/lib/email") as jest.Mocked<
  typeof import("@/lib/email")
>;
const {
  applyOneTimePayment,
  applySuccessfulCharge,
  claimSubscriptionForConfirm,
  releaseSubscriptionLease,
  scheduleSubscriptionStart,
} = require("@/lib/subscriptions") as typeof import("@/lib/subscriptions");
const { chargeDueSubscriptions } =
  require("@/lib/subscription-renewals") as typeof import("@/lib/subscription-renewals");
const { reconcilePayment } =
  require("@/lib/payment-reconciliation") as typeof import("@/lib/payment-reconciliation");
const { refundPayment } =
  require("@/lib/refunds") as typeof import("@/lib/refunds");
const { deleteRetiredBillingKeys, retireBillingKey } =
  require("@/lib/billing-keys") as typeof import("@/lib/billing-keys");
const { deleteUserRow } =
  require("@/lib/account-deletion") as typeof import("@/lib/account-deletion");

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
  userId: number,
  values: {
    status: string;
    billingKey?: string | null;
    currentPeriodEnd?: Date | null;
    nextBillingAt?: Date | null;
    failedChargeCount?: number;
    renewalNoticeSentAt?: Date | null;
    graceNoticeSentAt?: Date | null;
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
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  return row.id;
}

async function makePendingPayment(opts: {
  userId: number;
  subscriptionId: number | null;
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

function subscription(id: number) {
  return db
    .selectFrom("subscriptions")
    .selectAll()
    .where("id", "=", id)
    .executeTakeFirstOrThrow();
}

async function supporterUntil(userId: number) {
  const row = await db
    .selectFrom("users")
    .select("supporter_until")
    .where("id", "=", userId)
    .executeTakeFirstOrThrow();
  return row.supporter_until ? new Date(row.supporter_until) : null;
}

integration("payments against the database", () => {
  beforeEach(async () => {
    await sql`truncate users, subscriptions, payments, retired_billing_keys restart identity cascade`.execute(
      db,
    );
    jest.clearAllMocks();
    toss.chargeBillingKey.mockReset();
    toss.cancelPayment.mockReset();
    toss.deleteBillingKey.mockReset();
    toss.deleteBillingKey.mockResolvedValue(undefined);
    toss.getPaymentByOrderId.mockRejectedValue(
      new toss.TossApiError("not found", 404),
    );
  });

  afterAll(async () => {
    await db.destroy();
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
    async function paidPayment(userId: number) {
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

    function attempts(subId: number) {
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
});
