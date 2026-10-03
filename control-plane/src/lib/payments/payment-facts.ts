import type { Selectable, Transaction } from "kysely";
import { db } from "@/lib/database";
import type { DB } from "@/lib/db";
import type { Executor } from "@/lib/entitlements";
import {
  ENDED_SUBSCRIPTION_STATUSES,
  LIVE_SUBSCRIPTION_STATUSES,
  isOneOf,
} from "@/lib/payments/payment-states";
import {
  addInterval,
  addMonths,
  oneTimeYearsForAmount,
  paymentFlowForRecord,
  paymentProviderMetadata,
  type BillingInterval,
  type TossPaymentResult,
} from "@/lib/payments/toss";
import { endPlan, retireUnusedSignupKey } from "@/lib/payments/subscriptions";
import { recordApproval, recordCancels } from "@/lib/payments/payment-ledger";
import {
  extendPaidTime,
  lockPaidTime,
  recomputePaidTime,
} from "@/lib/payments/paid-time";
import { enqueueJob } from "@/lib/payments/payment-jobs";
import {
  kstDate,
  notePaymentEvent,
  recordPaymentEvent,
  won,
} from "@/lib/payments/payment-events";

const ENDED_PAYMENT_STATUSES = [
  "canceled",
  "aborted",
  "expired",
  "failed",
] as const;
export class TossPaymentMismatchError extends Error {
  constructor(orderId: string) {
    super(`Toss payment mismatch for order ${orderId}`);
    this.name = "TossPaymentMismatchError";
  }
}

type Payment = Selectable<DB["payments"]>;
type Period = { periodStart: Date; periodEnd: Date; granted: boolean };
export type AppliedTossPayment = (
  | ({ state: "done" } & Period)
  | { state: "pending" }
  | { state: "failed"; status: string }
  | { state: "refunded"; amount: number; subscriptionCanceled: boolean }
) & { retiredKey: string | null };

type Grant =
  | { kind: "one-time"; years: number }
  | {
      kind: "billing";
      subscriptionId: string;
      interval: BillingInterval;
      from: Date;
      notice: "thank_you" | "receipt";
    };

type ApplyOptions = {
  // A renewal applies its decline and retry policy in the same transaction.
  transaction?: Transaction<DB>;
  failureSummary?: string;
  from?: Date;
  notice?: "thank_you" | "receipt";
};

// All verified server responses (approval, cancel, lookup) enter here. No Toss
// calls or email delivery happen in this transaction. Callers hold the account
// lock; row locks consistently follow payments -> users -> subscriptions.
export async function applyVerifiedTossPayment(
  paymentId: string,
  tossPayment: TossPaymentResult,
  options: ApplyOptions = {},
): Promise<AppliedTossPayment> {
  const opts = { paymentId, payment: tossPayment, ...options };
  let owner: Payment | undefined;
  try {
    const apply = async (trx: Transaction<DB>): Promise<AppliedTossPayment> => {
      const id = opts.paymentId;
      const payment = await trx
        .selectFrom("payments")
        .selectAll()
        .where("id", "=", id)
        .forUpdate()
        .executeTakeFirstOrThrow();
      owner = payment;
      if (
        opts.payment.orderId !== payment.order_id ||
        opts.payment.totalAmount !== payment.amount ||
        (payment.toss_mid &&
          opts.payment.mId &&
          payment.toss_mid !== opts.payment.mId) ||
        (payment.toss_payment_key &&
          payment.toss_payment_key !== opts.payment.paymentKey)
      ) {
        throw new TossPaymentMismatchError(payment.order_id);
      }
      const metadata = {
        ...paymentProviderMetadata(
          opts.payment,
          paymentFlowForRecord(payment.toss_flow, payment.attempt_key),
        ),
        toss_mid: opts.payment.mId ?? payment.toss_mid,
        toss_payment_key: opts.payment.paymentKey,
        raw: JSON.stringify(opts.payment),
      };
      const status =
        opts.payment.status === "PARTIAL_CANCELED"
          ? "canceled"
          : opts.payment.status.toLowerCase();
      if (status === "done") {
        if (payment.status === "canceled") return existingMoneyResult(payment);
        if (payment.status === "done") {
          await trx
            .updateTable("payments")
            .set(metadata)
            .where("id", "=", id)
            .execute();
          return existingMoneyResult(payment);
        }
        assertGrantable(id, payment.status);
        const grant = await grantForPayment(trx, payment, opts);
        return {
          state: "done",
          ...(await grantApproval(trx, payment, opts.payment, metadata, grant)),
          retiredKey: null,
        };
      }
      if (isOneOf(ENDED_PAYMENT_STATUSES, status)) {
        // An older unpaid observation cannot overwrite money already recorded.
        if (
          status !== "canceled" &&
          (payment.status === "done" || payment.status === "canceled")
        ) {
          return existingMoneyResult(payment);
        }
        return applyEndedPayment(
          trx,
          payment,
          opts.payment,
          metadata,
          status,
          opts.failureSummary,
        );
      }
      // READY/IN_PROGRESS are observations, not transitions back to pending.
      if (payment.status === "done" || payment.status === "canceled")
        return existingMoneyResult(payment);
      await trx
        .updateTable("payments")
        .set(metadata)
        .where("id", "=", id)
        .execute();
      return { state: "pending", retiredKey: null };
    };
    return opts.transaction
      ? await apply(opts.transaction)
      : await db.transaction().execute(apply);
  } catch (error) {
    if (owner && !opts.transaction)
      await noteOrphanedCharge(error, {
        userId: owner.user_id,
        subscriptionId: owner.subscription_id ?? undefined,
        payment: opts.payment,
      });
    throw error;
  }
}

function existingMoneyResult(payment: Payment): AppliedTossPayment {
  if (payment.status === "canceled")
    return {
      state: "refunded",
      amount: payment.refunded_amount,
      subscriptionCanceled: false,
      retiredKey: null,
    };
  if (!payment.period_start || !payment.period_end)
    throw new Error(`Payment ${payment.id} has no paid period`);
  return {
    state: "done",
    periodStart: new Date(payment.period_start),
    periodEnd: new Date(payment.period_end),
    granted: false,
    retiredKey: null,
  };
}

async function grantForPayment(
  trx: Executor,
  payment: Payment,
  options: ApplyOptions,
): Promise<Grant> {
  if (payment.subscription_id === null) {
    const years = oneTimeYearsForAmount(payment.amount);
    if (years === null)
      throw new Error(`Payment ${payment.id} has an invalid one-time amount`);
    return {
      kind: "one-time",
      years,
    };
  }
  const subscription = await trx
    .selectFrom("subscriptions")
    .select(["billing_interval", "current_period_end"])
    .where("id", "=", payment.subscription_id)
    .where("user_id", "=", payment.user_id)
    .executeTakeFirstOrThrow();
  const now = new Date();
  const currentEnd = subscription.current_period_end
    ? new Date(subscription.current_period_end)
    : now;
  const initial = payment.attempt_key?.startsWith("subscription_initial:");
  return {
    kind: "billing",
    subscriptionId: payment.subscription_id,
    interval: subscription.billing_interval as BillingInterval,
    from: options.from ?? (initial || currentEnd < now ? now : currentEnd),
    notice: options.notice ?? (initial ? "thank_you" : "receipt"),
  };
}

async function grantApproval(
  trx: Executor,
  payment: Payment,
  tossPayment: TossPaymentResult,
  metadata: ReturnType<typeof paymentProviderMetadata> & {
    toss_payment_key: string;
    raw: string;
  },
  grant: Grant,
): Promise<Period> {
  const now = new Date();
  const paidAt = approvedAt(tossPayment, now);
  const paidUntil = await lockPaidTime(trx, payment.user_id);
  const base = grant.kind === "one-time" ? now : grant.from;
  const periodStart = paidUntil && paidUntil > base ? paidUntil : base;
  const periodEnd =
    grant.kind === "one-time"
      ? addMonths(periodStart, 12 * grant.years)
      : addInterval(periodStart, grant.interval);
  // Same transaction as the ledger, entitlement, plan, event and mail intent.
  await trx
    .updateTable("payments")
    .set({
      ...metadata,
      status: "done",
      paid_at: paidAt,
      period_start: periodStart,
      period_end: periodEnd,
    })
    .where("id", "=", payment.id)
    .execute();
  await recordApproval(trx, {
    paymentId: payment.id,
    amount: payment.amount,
    at: paidAt,
  });
  let subscriptionId: string | undefined;
  let summary: string;
  if (grant.kind === "one-time") {
    const deferred = await trx
      .updateTable("subscriptions")
      .set({
        current_period_end: periodEnd,
        next_billing_at: periodEnd,
        updated_at: now,
      })
      .where("user_id", "=", payment.user_id)
      .where("status", "in", ["active", "scheduled"])
      .where("next_billing_at", "<", periodEnd)
      .returning("id")
      .executeTakeFirst();
    subscriptionId = deferred?.id;
    summary = `한 번만 결제 ${won(payment.amount)} (${grant.years}년) · ${kstDate(periodEnd)}까지${deferred ? " · 진행 중인 정기 결제의 다음 결제를 그 뒤로 미룸" : ""}`;
  } else {
    const subscription = await trx
      .selectFrom("subscriptions")
      .select(["status", "billing_key_id"])
      .where("id", "=", grant.subscriptionId)
      .where("user_id", "=", payment.user_id)
      .forUpdate()
      .executeTakeFirstOrThrow();
    const stopped = ENDED_SUBSCRIPTION_STATUSES.includes(subscription.status);
    const renewable = !stopped && subscription.billing_key_id != null;
    await trx
      .updateTable("subscriptions")
      .set({
        status: renewable ? "active" : subscription.status,
        current_period_start: periodStart,
        current_period_end: periodEnd,
        next_billing_at: renewable ? periodEnd : null,
        failed_charge_count: 0,
        renewal_notice_sent_at: null,
        payment_grace_notice_sent_at: null,
        updated_at: now,
      })
      .where("id", "=", grant.subscriptionId)
      .execute();
    subscriptionId = grant.subscriptionId;
    summary = `정기 결제 ${won(payment.amount)} (${grant.interval === "month" ? "월간" : "연간"}) · ${kstDate(periodEnd)}까지${stopped ? ` · 구독은 ${subscription.status} 그대로` : renewable ? "" : " · 빌링키가 없어 자동 갱신은 하지 않음"}`;
  }
  await extendPaidTime(trx, payment.user_id, periodEnd);
  await recordPaymentEvent(trx, {
    kind: "charge_succeeded",
    userId: payment.user_id,
    paymentId: payment.id,
    subscriptionId,
    summary,
  });
  const notice = grant.kind === "one-time" ? "thank_you" : grant.notice;
  await enqueueJob(
    trx,
    {
      kind: notice === "receipt" ? "charge_receipt" : "thank_you",
      paymentId: payment.id,
    },
    { dedupeKey: `${notice}:${payment.id}` },
  );
  return { periodStart, periodEnd, granted: true };
}

export class UngrantableChargeError extends Error {
  constructor(
    public readonly paymentId: string,
    public readonly status: string,
  ) {
    super(`Payment ${paymentId} is ${status}, not pending`);
    this.name = "UngrantableChargeError";
  }
}

function assertGrantable(paymentId: string, status: string) {
  if (status !== "pending") {
    throw new UngrantableChargeError(paymentId, status);
  }
}

// Toss approved a charge whose order the ledger had already settled another
// way: money taken with no period granted, and — since expired and failed
// rows are never looked at again — nothing that will fix it. Logged on its own
// so it stands out of the routine unresolved charges; a person refunds it in
// the Toss dashboard or grants the period. Recorded after the grant's
// transaction has rolled back, so never inside it.
async function noteOrphanedCharge(
  error: unknown,
  opts: { userId: string; subscriptionId?: string; payment: TossPaymentResult },
) {
  if (!(error instanceof UngrantableChargeError)) return;
  if (opts.payment.status !== "DONE") return;
  console.error(
    `[payments] ORPHANED charge: order ${opts.payment.orderId} was approved at Toss but payment ${error.paymentId} is ${error.status}`,
  );
  await notePaymentEvent({
    kind: "charge_orphaned",
    userId: opts.userId,
    paymentId: error.paymentId,
    subscriptionId: opts.subscriptionId ?? null,
    summary: `Toss에서 승인된 결제 ${won(opts.payment.totalAmount)} (주문 ${opts.payment.orderId}, paymentKey ${opts.payment.paymentKey})가 이미 ${error.status} 상태라 기간을 부여하지 못함 — Toss 대시보드에서 환불하거나 기간을 직접 부여해야 함`,
  });
}

// When the money moved: Toss's approval time. Usually a moment ago, but an
// orphaned charge recovered weeks later must not get a fresh refund window or
// count as paid after plans it predates.
function approvedAt(payment: TossPaymentResult, fallback: Date): Date {
  const at = payment.approvedAt ? new Date(payment.approvedAt) : null;
  return at && !Number.isNaN(at.getTime()) && at <= fallback ? at : fallback;
}

async function applyEndedPayment(
  trx: Executor,
  payment: Payment,
  tossPayment: TossPaymentResult,
  metadata: ReturnType<typeof paymentProviderMetadata> & {
    toss_payment_key: string;
    raw: string;
  },
  status: (typeof ENDED_PAYMENT_STATUSES)[number],
  failureSummary?: string,
): Promise<AppliedTossPayment> {
  const initialAttempt =
    payment.subscription_id != null &&
    (payment.attempt_key?.startsWith("subscription_initial:") ?? false);
  let refundedAmount = 0;
  let refundedAt: Date | null = null;
  // The user next, before the ledger is read: a charge granted while
  // this runs holds this lock (payments, users, subscriptions), so its
  // period is in the ledger read below rather than overwritten by a
  // supporter_until recomputed without it.
  await lockPaidTime(trx, payment.user_id);
  ({ refundedAmount, refundedAt } = await recordCancels(trx, {
    paymentId: payment.id,
    payment: tossPayment,
    fallbackAt: new Date(),
  }));
  await trx
    .updateTable("payments")
    .set({
      ...metadata,
      status,
      refunded_amount: refundedAmount,
      refunded_at: refundedAt,
    })
    .where("id", "=", payment.id)
    .execute();

  // Refunding takes back the time the refunded money paid for. Without
  // this a chargeback bought a free supporter year: the money went back
  // and the entitlement stayed. Recomputed from the ledger rather than
  // subtracted, so a refund cannot disturb periods other payments paid
  // for. Only when this reconciliation found new refunded money: an
  // order that simply failed or expired paid for nothing and changes
  // nothing.
  const newlyRefunded = refundedAmount > payment.refunded_amount;
  const recomputed = newlyRefunded
    ? await recomputePaidTime(trx, payment.user_id)
    : null;

  // A refund ends the billing relationship, not just this one charge:
  // the recurring plan the account had when the money went back must
  // not charge the card again — the refunded renewal's own plan, or
  // one running beside a refunded one-time payment. Done here, the
  // first time the refund is seen, so a refund made in the Toss
  // dashboard or one whose cancel call got no answer stops it as well
  // as an accepted refund task. Its cancel is told in the
  // refund's own mail.
  //
  // Only a plan that already existed when the refund happened: one the
  // supporter started since — before a late webhook or the refund sweep
  // brought the refund in — is theirs to keep.
  let stopped: { id: string; retiredKey: string | null } | null = null;
  if (newlyRefunded) {
    const refundedBy = refundedAt ?? new Date();
    const query = trx
      .selectFrom("subscriptions")
      .select("id")
      .where("user_id", "=", payment.user_id)
      .where("status", "in", LIVE_SUBSCRIPTION_STATUSES);
    // An accepted local refund targets the plan captured at request
    // time. Dashboard refunds still use the provider's cancel time.
    const live = payment.refund_requested_at
      ? payment.refund_subscription_id
        ? await query
            .where("id", "=", payment.refund_subscription_id)
            .executeTakeFirst()
        : undefined
      : await query.where("created_at", "<=", refundedBy).executeTakeFirst();
    const ended = live
      ? await endPlan(trx, live.id, {
          summary: () => "환불에 따라 정기 결제도 취소",
          at: refundedBy,
        })
      : null;
    if (live && ended) {
      stopped = { id: live.id, retiredKey: ended.retiredKey };
    }
  }
  // A plan the refund leaves running — one started after the refund —
  // must charge when the paid time it now has ends. Its own dates may
  // still point past that (prepaid time a scheduled start waited for),
  // and left there it shows as running while access is gone. Pulled
  // back, never pushed out; with no paid time left it is charged on
  // the next run.
  if (newlyRefunded && !stopped) {
    const due = recomputed && recomputed > new Date() ? recomputed : new Date();
    await trx
      .updateTable("subscriptions")
      .set({
        current_period_end: due,
        next_billing_at: due,
        updated_at: new Date(),
      })
      .where("user_id", "=", payment.user_id)
      .where("status", "in", ["active", "scheduled"])
      .where("next_billing_at", ">", due)
      .execute();
  }
  if (newlyRefunded) {
    await recordPaymentEvent(trx, {
      kind: "refunded",
      userId: payment.user_id,
      paymentId: payment.id,
      subscriptionId: payment.subscription_id ?? stopped?.id,
      summary: `환불 ${won(refundedAmount)} / ${won(payment.amount)} (주문 ${payment.order_id}) · 이용 기한은 ${recomputed ? recomputed.toISOString().slice(0, 10) : "없음"}으로 다시 계산${stopped ? " · 정기 결제 취소" : ""}`,
    });
  } else if (status !== payment.status && refundedAmount === 0) {
    await recordPaymentEvent(trx, {
      kind: status === "expired" ? "order_expired" : "charge_failed",
      userId: payment.user_id,
      paymentId: payment.id,
      subscriptionId: payment.subscription_id,
      summary:
        failureSummary ??
        `주문 ${payment.order_id} (${won(payment.amount)}): Toss 상태 ${tossPayment.status}`,
    });
  }

  // Enqueued with the refund it reports, once per refunded amount.
  if (newlyRefunded) {
    await enqueueJob(
      trx,
      {
        kind: "payment_canceled",
        paymentId: payment.id,
        subscriptionCanceled: !!stopped,
      },
      { dedupeKey: `payment_canceled:${payment.id}:${refundedAmount}` },
    );
  }
  const retiredKey = stopped
    ? stopped.retiredKey
    : initialAttempt && refundedAmount === 0
      ? await retireUnusedSignupKey(trx, payment.subscription_id!)
      : null;
  return status === "canceled"
    ? {
        state: "refunded",
        amount: refundedAmount,
        subscriptionCanceled: !!stopped,
        retiredKey,
      }
    : { state: "failed", status, retiredKey };
}
