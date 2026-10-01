/** @jest-environment node */
import { afterAll, describe, expect, jest, test } from "@jest/globals";
import { AsyncLocalStorage } from "async_hooks";
import type { TossPaymentResult } from "@/lib/payments/toss";

// Random payment operations, several at once, on a handful of accounts,
// against a fake Toss that approves, declines, loses answers and fails at
// random — then checks what must hold however they interleaved: no one is
// charged twice for a period, every approved charge is recorded and granted,
// no key is deleted while a plan uses it or charged after it was retired, and
// the payment invariants hold. A failure prints its seed; FUZZ_SEED reruns
// it, FUZZ_RUNS and FUZZ_STEPS run more, from FUZZ_FIRST_SEED (the nightly
// payments-fuzz workflow).

type FakeOrder = {
  orderId: string;
  paymentKey: string;
  amount: number;
  status: "DONE" | "ABORTED" | "CANCELED";
  cancels: Array<{
    cancelAmount: number;
    canceledAt: string;
    transactionKey: string;
  }>;
  approvedAt: string;
};

const fake = {
  chaos: true,
  random: Math.random,
  orders: new Map<string, FakeOrder>(),
  keys: new Map<string, { deleted: boolean }>(),
  issued: new Map<string, string>(),
  keyCounter: 0,
  txCounter: 0,
  violations: [] as string[],
  // Set by the test: whether a plan holds this key right now.
  heldKey: async (_billingKey: string): Promise<boolean> => false,
  usableKey: async (_billingKey: string): Promise<boolean> => true,
};

function asPayment(order: FakeOrder): TossPaymentResult {
  return {
    paymentKey: order.paymentKey,
    orderId: order.orderId,
    status:
      order.status === "CANCELED" &&
      order.cancels.reduce((t, c) => t + c.cancelAmount, 0) < order.amount
        ? "PARTIAL_CANCELED"
        : order.status,
    totalAmount: order.amount,
    approvedAt: order.approvedAt,
    cancels: order.cancels.length > 0 ? [...order.cancels] : null,
  };
}

jest.mock("@/lib/payments/toss", () => {
  const actual = jest.requireActual<typeof import("@/lib/payments/toss")>(
    "@/lib/payments/toss",
  );
  const { TossApiError } = actual;
  const roll = () => fake.random();
  const pause = () =>
    new Promise((resolve) => setTimeout(resolve, Math.floor(roll() * 5)));
  const approve = (orderId: string, amount: number): FakeOrder => {
    const order: FakeOrder = {
      orderId,
      paymentKey: `pk-${orderId}`,
      amount,
      status: "DONE",
      cancels: [],
      approvedAt: new Date().toISOString(),
    };
    fake.orders.set(orderId, order);
    return order;
  };
  return {
    ...actual,
    issueBillingKey: jest.fn(async (authKey: string, customerKey: string) => {
      await pause();
      let billingKey = fake.issued.get(authKey);
      if (!billingKey) {
        fake.keyCounter += 1;
        billingKey = `fuzz-key-${fake.keyCounter}`;
        fake.issued.set(authKey, billingKey);
        fake.keys.set(billingKey, { deleted: false });
      }
      return { billingKey, customerKey };
    }),
    chargeBillingKey: jest.fn(
      async (params: {
        billingKey: string;
        orderId: string;
        amount: number;
      }) => {
        await pause();
        if (!(await fake.usableKey(params.billingKey))) {
          fake.violations.push(
            `charged ${params.billingKey}, which no plan holds as active`,
          );
        }
        const key = fake.keys.get(params.billingKey);
        if (!key || key.deleted) {
          throw new TossApiError("no such key", 404, "NOT_FOUND_BILLING");
        }
        const existing = fake.orders.get(params.orderId);
        if (existing) {
          if (existing.status === "ABORTED") {
            throw new TossApiError("declined", 403, "REJECT_CARD_PAYMENT");
          }
          return asPayment(existing);
        }
        const r = fake.chaos ? roll() : 0;
        if (r < 0.6) return asPayment(approve(params.orderId, params.amount));
        if (r < 0.75) {
          fake.orders.set(params.orderId, {
            ...approve(params.orderId, params.amount),
            status: "ABORTED",
          });
          throw new TossApiError("declined", 403, "REJECT_CARD_PAYMENT");
        }
        if (r < 0.9) {
          // Approved, but the answer was lost.
          approve(params.orderId, params.amount);
          throw new TossApiError("server error", 500);
        }
        throw new TypeError("fetch failed");
      },
    ),
    confirmPayment: jest.fn(
      async (params: { orderId: string; amount: number }) => {
        await pause();
        const existing = fake.orders.get(params.orderId);
        if (existing) {
          throw new TossApiError(
            "already processed",
            400,
            "ALREADY_PROCESSED_PAYMENT",
          );
        }
        const r = fake.chaos ? roll() : 0;
        if (r < 0.8) return asPayment(approve(params.orderId, params.amount));
        if (r < 0.9) {
          approve(params.orderId, params.amount);
          throw new TossApiError("server error", 500);
        }
        throw new TypeError("fetch failed");
      },
    ),
    getPaymentByOrderId: jest.fn(async (orderId: string) => {
      await pause();
      if (fake.chaos && roll() < 0.1) {
        throw new TossApiError("server error", 500);
      }
      const order = fake.orders.get(orderId);
      if (!order) throw new TossApiError("not found", 404, "NOT_FOUND_PAYMENT");
      return asPayment(order);
    }),
    cancelPayment: jest.fn(async (params: { paymentKey: string }) => {
      await pause();
      const order = [...fake.orders.values()].find(
        (o) => o.paymentKey === params.paymentKey,
      );
      if (!order || order.status !== "DONE") {
        throw new TossApiError(
          "not cancelable",
          400,
          order ? "ALREADY_CANCELED_PAYMENT" : "NOT_FOUND_PAYMENT",
        );
      }
      fake.txCounter += 1;
      order.status = "CANCELED";
      order.cancels.push({
        cancelAmount: order.amount,
        canceledAt: new Date().toISOString(),
        transactionKey: `fuzz-tx-${fake.txCounter}`,
      });
      if (fake.chaos && roll() < 0.1) {
        throw new TossApiError("server error", 500);
      }
      return asPayment(order);
    }),
    deleteBillingKey: jest.fn(async (billingKey: string) => {
      await pause();
      if (await fake.heldKey(billingKey)) {
        fake.violations.push(`deleted ${billingKey} while a plan held it`);
      }
      if (fake.chaos && roll() < 0.15) {
        throw new TossApiError("server error", 500);
      }
      const key = fake.keys.get(billingKey);
      if (key) key.deleted = true;
    }),
  };
});
jest.mock("@/lib/email", () => ({
  setPaymentMailRecorder: jest.fn(),
  sendSubscriptionPaymentGraceEmail: jest.fn(async () => {}),
  sendSubscriptionPastDueEmail: jest.fn(async () => {}),
  sendSupportThankYouEmail: jest.fn(async () => {}),
  sendRecurringChargeReceiptEmail: jest.fn(async () => {}),
  sendPaymentCanceledEmail: jest.fn(async () => {}),
  sendSubscriptionCanceledEmail: jest.fn(async () => {}),
}));
jest.mock("@/lib/auth", () => ({ validateRequest: jest.fn() }));

// Required after the mocks: this transform does not hoist jest.mock above
// imports.
const { sql } = require("kysely") as typeof import("kysely");
const { db } = require("@/lib/database") as typeof import("@/lib/database");
const auth = require("@/lib/auth") as jest.Mocked<typeof import("@/lib/auth")>;
const { NextRequest } = require("next/server") as typeof import("next/server");
const { TossApiError } =
  require("@/lib/payments/toss") as typeof import("@/lib/payments/toss");
const { AccountBusyError, closeAccountLockPool } =
  require("@/lib/payments/account-lock") as typeof import("@/lib/payments/account-lock");
const signup =
  require("@/lib/payments/subscription-signup") as typeof import("@/lib/payments/subscription-signup");
const { enqueueDueRenewals } =
  require("@/lib/payments/subscription-renewals") as typeof import("@/lib/payments/subscription-renewals");
const { reconcilePayment } =
  require("@/lib/payments/payment-reconciliation") as typeof import("@/lib/payments/payment-reconciliation");
const { refundPayment, RefundError } =
  require("@/lib/payments/refunds") as typeof import("@/lib/payments/refunds");
const { deleteRetiredBillingKeys } =
  require("@/lib/payments/billing-keys") as typeof import("@/lib/payments/billing-keys");
const { runDueJobs, runJobs } =
  require("@/lib/payments/payment-jobs") as typeof import("@/lib/payments/payment-jobs");
const { checkPaymentInvariants } =
  require("@/lib/payments/payment-invariants") as typeof import("@/lib/payments/payment-invariants");
const { POST: cancelRoute } =
  require("@/app/(main)/api/account/subscription/cancel/route") as typeof import("@/app/(main)/api/account/subscription/cancel/route");
const { POST: oneTimePrepareRoute } =
  require("@/app/(main)/api/account/donation/one-time/prepare/route") as typeof import("@/app/(main)/api/account/donation/one-time/prepare/route");
const { POST: oneTimeConfirmRoute } =
  require("@/app/(main)/api/account/donation/one-time/confirm/route") as typeof import("@/app/(main)/api/account/donation/one-time/confirm/route");
const { POST: tossWebhook } =
  require("@/app/(main)/api/webhooks/toss/route") as typeof import("@/app/(main)/api/webhooks/toss/route");

const integration =
  process.env.NARU_PAYMENTS_DB_TEST === "1" ? describe : describe.skip;
jest.setTimeout(300_000);

// mulberry32: small, seedable, good enough to pick operations.
function seeded(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const signedIn = new AsyncLocalStorage<string>();
auth.validateRequest.mockImplementation(async () => {
  const userId = signedIn.getStore();
  return (
    userId
      ? {
          user: {
            id: userId,
            email: `${userId}@example.com`,
            emailVerifiedAt: new Date(),
            loginName: userId,
          },
          session: {},
        }
      : { user: null, session: null }
  ) as Awaited<ReturnType<typeof auth.validateRequest>>;
});

function post(url: string, body: unknown) {
  return new NextRequest(`http://localhost${url}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

fake.heldKey = async (billingKey) =>
  (await db
    .selectFrom("subscriptions")
    .innerJoin(
      "billing_keys",
      "billing_keys.id",
      "subscriptions.billing_key_id",
    )
    .select("subscriptions.id")
    .where("billing_keys.billing_key", "=", billingKey)
    .executeTakeFirst()) != null;
fake.usableKey = async (billingKey) =>
  (await db
    .selectFrom("billing_keys")
    .select("id")
    .where("billing_key", "=", billingKey)
    .where("status", "=", "active")
    .executeTakeFirst()) != null;

// An operation that may be refused for reasons that are not bugs: a busy
// account, a refund outside what is allowed or not confirmed yet, and a
// cancel Toss refused (the refund route answers it as Toss's own message).
function expected(error: unknown): boolean {
  return (
    error instanceof AccountBusyError ||
    error instanceof RefundError ||
    (error instanceof TossApiError &&
      error.status < 500 &&
      error.code !== "ALREADY_CANCELED_PAYMENT" &&
      error.code !== "ALREADY_REFUNDING_PAYMENT")
  );
}

// Reconciliation reports a lookup Toss did not answer by throwing; its
// callers (the cron, the refund sweep) try again later.
function lookupFailed(error: unknown): boolean {
  return (
    (error instanceof TossApiError && error.status >= 500) ||
    (error instanceof TypeError && error.message === "fetch failed")
  );
}

async function currentPlan(userId: string) {
  return db
    .selectFrom("subscriptions")
    .select(["id", "status"])
    .where("user_id", "=", userId)
    .orderBy("id", "desc")
    .executeTakeFirst();
}

// weight: how often it is picked. Renewals and signups dominate, so a plan
// lives long enough to be renewed, retried and changed.
type Op = { name: string; weight: number; run: () => Promise<unknown> };

function choose(ops: Op[], pick: () => number): Op {
  let r = pick() * ops.reduce((total, op) => total + op.weight, 0);
  for (const op of ops) {
    r -= op.weight;
    if (r < 0) return op;
  }
  return ops[ops.length - 1];
}

function operations(userId: string, pick: () => number): Op[] {
  const authKey = () => `auth-${Math.floor(pick() * 1e9)}`;
  return [
    {
      name: "signup",
      weight: 1.5,
      run: async () => {
        const prepared = await signup.prepareSubscription({
          userId,
          interval: pick() < 0.5 ? "month" : "year",
        });
        if (!prepared.ok) return prepared;
        const confirm = () =>
          signup.confirmSubscription({
            userId,
            authKey: `signup-${prepared.registrationId}`,
            customerKey: prepared.customerKey,
            registrationId: prepared.registrationId,
          });
        // Sometimes the callback is doubled.
        return pick() < 0.3 ? Promise.all([confirm(), confirm()]) : confirm();
      },
    },
    {
      name: "card change",
      weight: 1,
      run: async () => {
        const prepared = await signup.prepareCardChange({ userId });
        if (!prepared.ok) return prepared;
        return signup.confirmSubscription({
          userId,
          authKey: authKey(),
          customerKey: prepared.customerKey,
          registrationId: prepared.registrationId,
        });
      },
    },
    {
      name: "cancel",
      weight: 0.25,
      run: () =>
        signedIn.run(userId, () =>
          cancelRoute(post("/api/account/subscription/cancel", {})),
        ),
    },
    {
      // The hourly run: renews what the clock has made due.
      name: "renewal run",
      weight: 3,
      run: async () => {
        const { jobs } = await enqueueDueRenewals();
        return runJobs(jobs);
      },
    },
    {
      name: "refund",
      weight: 0.4,
      run: async () => {
        const paid = await db
          .selectFrom("payments")
          .select("id")
          .where("user_id", "=", userId)
          .where("status", "=", "done")
          .execute();
        if (paid.length === 0) return;
        const payment = paid[Math.floor(pick() * paid.length)];
        return refundPayment({
          paymentId: payment.id,
          overridePolicy: true,
          reason: "fuzz",
        });
      },
    },
    {
      name: "one-time purchase",
      weight: 0.5,
      run: () =>
        signedIn.run(userId, async () => {
          const prepared = await oneTimePrepareRoute(
            post("/api/account/donation/one-time/prepare", { years: 1 }),
          );
          const body = (await prepared.json()) as {
            success: boolean;
            orderId?: string;
            amount?: number;
          };
          if (!body.success || !body.orderId) return body;
          return oneTimeConfirmRoute(
            post("/api/account/donation/one-time/confirm", {
              paymentKey: `pk-${body.orderId}`,
              orderId: body.orderId,
              amount: body.amount,
            }),
          );
        }),
    },
    {
      name: "reconcile",
      weight: 1,
      run: async () => {
        const pending = await db
          .selectFrom("payments")
          .select("id")
          .where("user_id", "=", userId)
          .where("status", "=", "pending")
          .execute();
        for (const payment of pending) {
          await reconcilePayment(payment.id, { waitMs: 0 }).catch(
            (error: unknown) => {
              if (!expected(error) && !lookupFailed(error)) throw error;
            },
          );
        }
      },
    },
    {
      name: "status webhook",
      weight: 1,
      run: async () => {
        const payments = await db
          .selectFrom("payments")
          .select("order_id")
          .where("user_id", "=", userId)
          .execute();
        if (payments.length === 0) return;
        const { order_id } = payments[Math.floor(pick() * payments.length)];
        return tossWebhook(
          post("/api/webhooks/toss", {
            eventType: "PAYMENT_STATUS_CHANGED",
            createdAt: new Date().toISOString(),
            data: { orderId: order_id },
          }),
        );
      },
    },
    {
      name: "key deleted at Toss",
      weight: 0.15,
      run: async () => {
        const plan = await currentPlan(userId);
        if (!plan) return;
        const held = await db
          .selectFrom("subscriptions")
          .innerJoin(
            "billing_keys",
            "billing_keys.id",
            "subscriptions.billing_key_id",
          )
          .select("billing_keys.billing_key")
          .where("subscriptions.id", "=", plan.id)
          .executeTakeFirst();
        const billingKey = held?.billing_key;
        if (!billingKey || !fake.keys.has(billingKey)) return;
        fake.keys.get(billingKey)!.deleted = true;
        return tossWebhook(
          post("/api/webhooks/toss", {
            eventType: "BILLING_DELETED",
            createdAt: new Date().toISOString(),
            data: { billingKey },
          }),
        );
      },
    },
    {
      name: "cron",
      weight: 1,
      run: async () => {
        await deleteRetiredBillingKeys(new Date(Date.now() + 2 * 86_400_000));
        await runDueJobs();
      },
    },
  ];
}

async function reset() {
  await sql`truncate users, subscriptions, payments, billing_keys, card_registrations, payment_events, toss_webhook_deliveries, payment_jobs, toss_calls, toss_window_outcomes, payment_mails, payment_cron_runs restart identity cascade`.execute(
    db,
  );
  fake.orders.clear();
  fake.keys.clear();
  fake.issued.clear();
  fake.violations = [];
  fake.chaos = true;
}

async function makeUsers(count: number, seed: number) {
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const row = await db
      .insertInto("users")
      .values({
        login_name: `fuzz${seed}x${i}`,
        password_hash: "x",
        email: `fuzz${seed}x${i}@example.com`,
        email_verified_at: new Date(),
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    ids.push(row.id);
  }
  return ids;
}

// Lets everything left settle with Toss answering reliably: what is owed
// gets done, what is unknown gets known. Two days pass first, so orders Toss
// never saw are old enough to expire.
async function settle() {
  fake.chaos = false;
  jest.setSystemTime(Date.now() + 2 * DAY_MS);
  for (let round = 0; round < 3; round++) {
    const pending = await db
      .selectFrom("payments")
      .select("id")
      .where("status", "=", "pending")
      .execute();
    for (const payment of pending) {
      await reconcilePayment(payment.id).catch((error: unknown) => {
        if (!expected(error)) throw error;
      });
    }
  }
  await deleteRetiredBillingKeys(new Date(Date.now() + 2 * DAY_MS));
  // Job times are the database's clock, which the simulated one runs ahead
  // of.
  await sql`update payment_jobs set run_at = now() - interval '1 second'
            where done_at is null`.execute(db);
  await runDueJobs(1000);
}

// What must hold however the operations interleaved.
async function findProblems(): Promise<string[]> {
  const problems = [...fake.violations];
  const payments = await db
    .selectFrom("payments")
    .select([
      "id",
      "order_id",
      "status",
      "amount",
      "attempt_key",
      "subscription_id",
    ])
    .execute();
  const byOrder = new Map(payments.map((p) => [p.order_id, p]));

  // Every charge Toss approved is in the ledger as paid.
  for (const order of fake.orders.values()) {
    if (order.status === "ABORTED") continue;
    const row = byOrder.get(order.orderId);
    if (!row || !["done", "canceled"].includes(row.status)) {
      problems.push(
        `Toss approved ${order.orderId} but the ledger has it ${row?.status ?? "missing"}`,
      );
    }
  }
  // Nothing is recorded paid that Toss did not approve.
  for (const row of payments) {
    if (row.status !== "done") continue;
    const order = fake.orders.get(row.order_id);
    if (!order || order.status === "ABORTED") {
      problems.push(`${row.order_id} is done but Toss did not approve it`);
    }
  }
  // At most one charge per plan and period that was kept (a refunded one
  // does not count).
  const perPeriod = new Map<string, number>();
  for (const row of payments) {
    if (row.status !== "done") continue;
    // subscription:<plan>:<period end>:<try>[:r<n>] and
    // subscription_initial:<plan>:<try>: one paid charge per plan and period.
    const key =
      row.attempt_key?.startsWith("subscription:") ||
      row.attempt_key?.startsWith("subscription_initial:")
        ? row.attempt_key.replace(/:\d+(:r\d+)?$/, "")
        : null;
    if (!key) continue;
    perPeriod.set(key, (perPeriod.get(key) ?? 0) + 1);
  }
  for (const [key, count] of perPeriod) {
    if (count <= 1) continue;
    const planId = key.split(":")[1];
    const attempts = payments
      .filter((row) => row.subscription_id === planId)
      .map((row) => `${row.attempt_key} ${row.status}`);
    const events = await db
      .selectFrom("payment_events")
      .select(["kind", "summary"])
      .where("subscription_id", "=", planId)
      .orderBy("id")
      .execute();
    problems.push(
      `${key} was charged ${count} times; attempts ${JSON.stringify(attempts)}; events ${JSON.stringify(events.map((e) => `${e.kind}: ${e.summary}`))}`,
    );
  }
  // A key Toss deleted is not one a plan still charges.
  for (const [billingKey, state] of fake.keys) {
    if (state.deleted && (await fake.heldKey(billingKey))) {
      problems.push(`a plan still holds ${billingKey}, which Toss deleted`);
    }
  }
  const unsettled = payments.filter((row) => row.status === "pending");
  if (unsettled.length > 0) {
    problems.push(`${unsettled.length} orders still pending after settling`);
  }
  // Every issued key is either held or on its way out.
  const loose = await db
    .selectFrom("billing_keys as k")
    .select("k.id")
    .where("k.status", "=", "active")
    .where(({ not, exists, selectFrom }) =>
      not(
        exists(
          selectFrom("subscriptions as s")
            .select("s.id")
            .whereRef("s.billing_key_id", "=", "k.id"),
        ),
      ),
    )
    .execute();
  if (loose.length > 0)
    problems.push(`${loose.length} active keys no plan holds`);

  const invariants = await checkPaymentInvariants();
  for (const [rule, ids] of Object.entries(invariants)) {
    problems.push(`invariant: ${rule} (${ids.join(", ")})`);
    if (rule === "이용 기한이 결제 원장보다 짧음") {
      for (const userId of ids) {
        const user = await db
          .selectFrom("users")
          .select("supporter_until")
          .where("id", "=", userId)
          .executeTakeFirst();
        const ledger = await db
          .selectFrom("payments")
          .select([
            "attempt_key",
            "status",
            "period_start",
            "period_end",
            "paid_at",
            "refunded_amount",
          ])
          .where("user_id", "=", userId)
          .where("period_end", "is not", null)
          .orderBy("period_start")
          .execute();
        const events = await db
          .selectFrom("payment_events")
          .select(["kind", "summary"])
          .where("user_id", "=", userId)
          .orderBy("id")
          .execute();
        problems.push(
          `  supporter_until ${user?.supporter_until?.toISOString()}; ledger ${JSON.stringify(ledger)}; events ${JSON.stringify(events.map((e) => `${e.kind}: ${e.summary}`))}`,
        );
      }
    }
  }
  return problems;
}

const DAY_MS = 86_400_000;

async function fuzz(seed: number, steps: number) {
  await reset();
  const pick = seeded(seed);
  fake.random = pick;
  const users = await makeUsers(3, seed);
  const unexpected: string[] = [];
  for (let step = 0; step < steps; step++) {
    // Time passes between some steps: an hour to a month, so periods end,
    // renewals fall due, declines run into the grace period and past due.
    if (pick() < 0.4) {
      const hours = [1, 9, 24, 3 * 24, 10 * 24, 31 * 24][
        Math.floor(pick() * 6)
      ];
      jest.setSystemTime(Date.now() + hours * 60 * 60 * 1000);
    }
    // A few operations at once, on random accounts.
    const batch = Array.from({ length: 1 + Math.floor(pick() * 3) }, () => {
      const userId = users[Math.floor(pick() * users.length)];
      return choose(operations(userId, pick), pick);
    });
    const results = await Promise.allSettled(batch.map((op) => op.run()));
    results.forEach((result, i) => {
      if (result.status === "rejected" && !expected(result.reason)) {
        unexpected.push(
          `step ${step} ${batch[i].name}: ${result.reason instanceof Error ? result.reason.stack : String(result.reason)}`,
        );
      }
    });
  }
  await settle();
  if (process.env.FUZZ_VERBOSE) {
    const plans = await db
      .selectFrom("subscriptions")
      .select(["status", sql<number>`count(*)::int`.as("n")])
      .groupBy("status")
      .execute();
    const pays = await db
      .selectFrom("payments")
      .select(["status", sql<number>`count(*)::int`.as("n")])
      .groupBy("status")
      .execute();
    const keys = await db
      .selectFrom("billing_keys")
      .select(["status", sql<number>`count(*)::int`.as("n")])
      .groupBy("status")
      .execute();
    const events = await db
      .selectFrom("payment_events")
      .select(["kind", sql<number>`count(*)::int`.as("n")])
      .groupBy("kind")
      .execute();
    process.stdout.write(
      `seed ${seed}: plans ${JSON.stringify(plans)} payments ${JSON.stringify(pays)} keys ${JSON.stringify(keys)} events ${JSON.stringify(Object.fromEntries(events.map((e) => [e.kind, e.n])))}\n`,
    );
  }
  return [...unexpected, ...(await findProblems())];
}

integration("payments under random concurrent operations", () => {
  afterAll(async () => {
    await closeAccountLockPool();
    await db.destroy();
  });

  const runs = Number(process.env.FUZZ_RUNS ?? 4);
  const steps = Number(process.env.FUZZ_STEPS ?? 40);
  const seeds = process.env.FUZZ_SEED
    ? [Number(process.env.FUZZ_SEED)]
    : Array.from(
        { length: runs },
        (_, i) => Number(process.env.FUZZ_FIRST_SEED ?? 1000) + i,
      );

  for (const seed of seeds) {
    test(`seed ${seed}`, async () => {
      // The clock is simulated: only Date is faked, and it moves only when
      // the fuzzer says time passes. Timers, I/O and the database run for
      // real (the database's own now() stays behind, which only makes what
      // it stamps look older).
      jest.useFakeTimers({
        doNotFake: [
          "hrtime",
          "nextTick",
          "performance",
          "queueMicrotask",
          "requestAnimationFrame",
          "cancelAnimationFrame",
          "requestIdleCallback",
          "cancelIdleCallback",
          "setImmediate",
          "clearImmediate",
          "setInterval",
          "clearInterval",
          "setTimeout",
          "clearTimeout",
        ],
        now: Date.now(),
      });
      const silence = jest.spyOn(console, "error").mockImplementation(() => {});
      const log = jest.spyOn(console, "log").mockImplementation(() => {});
      try {
        expect({ seed, problems: await fuzz(seed, steps) }).toEqual({
          seed,
          problems: [],
        });
      } finally {
        jest.useRealTimers();
        silence.mockRestore();
        log.mockRestore();
      }
    });
  }
});
