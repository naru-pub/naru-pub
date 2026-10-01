import { AccountBusyError, withAccountLock } from "@/lib/account-lock";
import { db } from "@/lib/database";
import { deleteRetiredBillingKey } from "@/lib/billing-keys";
import {
  reconcilePayment,
  type ReconciliationResult,
} from "@/lib/payment-reconciliation";
import { runJobs } from "@/lib/payment-jobs";
import { LIVE_SUBSCRIPTION_STATUSES } from "@/lib/payment-states";
import { endPlan, plansOf } from "@/lib/subscriptions";
import { paymentFlowForRecord } from "@/lib/toss";
import { cancelOrder } from "@/lib/toss-gateway";

// 판매 정책의 환불 조건: 결제일로부터 7일 안에는 이유를 묻지 않고 전액 환불.
// 이 상수와 아래 판정 함수가 그 문장의 구현이므로, components/SupportPolicy의
// 문구를 고칠 때 함께 고쳐야 한다.
export const REFUND_WINDOW_DAYS = 7;

export type RefundBlockReason =
  | "not_paid"
  | "already_refunded"
  | "window_passed";

export type RefundEligibility =
  | { eligible: true; deadline: Date }
  | {
      eligible: false;
      reason: RefundBlockReason;
      message: string;
    };

export type RefundEligibilityInput = {
  status: string;
  paidAt: Date | string | null;
  refundedAmount: number;
  now?: Date;
};

export function refundDeadline(paidAt: Date | string): Date {
  const deadline = new Date(paidAt);
  deadline.setDate(deadline.getDate() + REFUND_WINDOW_DAYS);
  return deadline;
}

// 7일 안이면 끝이다. 유료 기능을 썼는지는 묻지 않는다 — 무엇을 물어야
// 하는지가 곧 무엇을 증명하라는 요구가 되고, 환불을 받을 사람이 자기 사용
// 기록을 해명하게 만드는 창구는 환불 창구가 아니기 때문이다.
//
// 운영자는 이 창을 넘겨서도 환불할 수 있다. 장애 보상 같은 정책 밖의 판단은
// 운영자 몫이라, 규칙을 두 사람이 함께 부르는 엔드포인트가 아니라 여기에 둔다.
export function refundEligibility(
  input: RefundEligibilityInput,
): RefundEligibility {
  const now = input.now ?? new Date();

  if (input.refundedAmount > 0) {
    return {
      eligible: false,
      reason: "already_refunded",
      message: "이미 환불된 결제입니다.",
    };
  }
  if (input.status !== "done" || !input.paidAt) {
    return {
      eligible: false,
      reason: "not_paid",
      message: "결제가 완료된 내역만 환불할 수 있습니다.",
    };
  }

  const deadline = refundDeadline(input.paidAt);
  if (now.getTime() > deadline.getTime()) {
    return {
      eligible: false,
      reason: "window_passed",
      message: `결제일로부터 ${REFUND_WINDOW_DAYS}일이 지나 환불할 수 없습니다.`,
    };
  }

  return { eligible: true, deadline };
}

export class RefundError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "RefundError";
  }
}

// Refunding ends the billing relationship, not just this one charge.
// Reconciliation stops the account's recurring plan when it first sees the
// refund; this is for a cancel Toss accepted but the lookup does not show yet.
async function stopRecurringBilling(userId: string): Promise<boolean> {
  const ended = await db.transaction().execute(async (trx) => {
    const live = await plansOf(trx, userId)
      .select("id")
      .where("status", "in", LIVE_SUBSCRIPTION_STATUSES)
      .executeTakeFirst();
    // The refund's own cancel mail went out before this stop, or goes out
    // later without it, so it cannot say so: this one does.
    return live
      ? endPlan(trx, live.id, {
          summary: () => "환불에 따라 정기 결제도 취소",
          notice: "refund",
        })
      : null;
  });
  if (!ended) return false;
  await deleteRetiredBillingKey(ended.retiredKey);
  await runJobs([ended.noticeJob]);
  return true;
}

// The account's subscription while it can still charge, or null.
async function runningPlanId(userId: string): Promise<string | null> {
  const row = await db
    .selectFrom("subscriptions")
    .select("id")
    .where("user_id", "=", userId)
    .where("status", "in", LIVE_SUBSCRIPTION_STATUSES)
    .executeTakeFirst();
  return row?.id ?? null;
}

export type RefundOutcome = {
  paymentId: string;
  amount: number;
  subscriptionCanceled: boolean;
};

// Performs the refund end to end: cancel at Toss, then re-read the payment from
// Toss so the ledger, supporter_until and the subscription all move in the one
// reconciliation path that every other refund (webhook, daily sync) goes
// through.
type RefundRequest = {
  paymentId: string;
  /** Operators may refund outside the policy window; owners may not. */
  overridePolicy: boolean;
  reason: string;
};

// Runs under the account lock (lib/account-lock): a second click, the
// webhook of this very cancel, or a renewal waits for it to finish.
export async function refundPayment(
  opts: RefundRequest,
): Promise<RefundOutcome> {
  const owner = await db
    .selectFrom("payments")
    .select("user_id")
    .where("id", "=", opts.paymentId)
    .executeTakeFirstOrThrow();
  try {
    return await withAccountLock(owner.user_id, { waitMs: 10_000 }, () =>
      refundLocked(opts),
    );
  } catch (error) {
    if (error instanceof AccountBusyError) {
      throw new RefundError(
        "다른 결제 작업을 처리하고 있습니다. 잠시 후 다시 시도해 주세요.",
        409,
      );
    }
    throw error;
  }
}

async function refundLocked(opts: RefundRequest): Promise<RefundOutcome> {
  const payment = await db
    .selectFrom("payments")
    .select([
      "id",
      "user_id",
      "amount",
      "status",
      "paid_at",
      "refunded_amount",
      "toss_payment_key",
      "attempt_key",
      "toss_flow",
    ])
    .where("id", "=", opts.paymentId)
    .executeTakeFirstOrThrow();

  if (payment.refunded_amount > 0) {
    throw new RefundError("이미 환불된 결제입니다.", 409);
  }
  if (payment.status !== "done" || !payment.paid_at) {
    throw new RefundError("결제가 완료된 내역만 환불할 수 있습니다.", 409);
  }
  if (!payment.toss_payment_key) {
    throw new RefundError(
      "결제 승인 정보가 없어 환불할 수 없습니다. 결제 상태를 먼저 확인해 주세요.",
      409,
    );
  }

  if (!opts.overridePolicy) {
    const eligibility = refundEligibility({
      status: payment.status,
      paidAt: payment.paid_at,
      refundedAmount: payment.refunded_amount,
    });
    if (!eligibility.eligible) {
      throw new RefundError(eligibility.message, 409);
    }
  }

  const planRunningBefore = await runningPlanId(payment.user_id);

  let refunded: ReconciliationResult | null = null;
  const canceled = await cancelOrder({
    flow: paymentFlowForRecord(payment.toss_flow, payment.attempt_key),
    paymentKey: payment.toss_payment_key,
    cancelReason: opts.reason.slice(0, 200),
  });
  if (canceled.kind !== "canceled") {
    // Toss refuses to cancel a payment that is already canceled — with
    // ALREADY_CANCELED_PAYMENT or NOT_CANCELABLE_PAYMENT, and the latter also
    // covers other refusals — and a call that got no answer (a timeout, a
    // dropped connection) may have canceled it all the same. Ask Toss what the
    // payment is now: if the money is already back, only the ledger is behind
    // and reconciliation catches it up, and the refund goes on to stop
    // recurring billing like any other.
    const result = await reconcilePayment(payment.id).catch(() => null);
    if (result?.state !== "refunded") {
      // Toss answered and did not cancel: the supporter can try again. Not
      // when it said the payment is already canceled — the money is back,
      // and only the lookup to confirm it failed.
      if (
        canceled.kind === "refused" &&
        canceled.error.code !== "ALREADY_CANCELED_PAYMENT"
      ) {
        throw canceled.error;
      }
      // No answer either way. The webhook and the refund sweep will see the
      // cancel if it happened; until then the supporter is told so rather
      // than that it failed, which would invite a second request.
      throw new RefundError(
        "환불 결과를 확인하고 있습니다. 잠시 후 결제 내역을 다시 확인해 주세요.",
        503,
      );
    }
    refunded = result;
  }

  // Toss accepted the cancel, so the refund has happened whatever the
  // lookup that follows says: a failed lookup is caught up by the webhook and
  // the refund sweep, and must not tell the supporter the refund failed.
  if (!refunded) {
    refunded = await reconcilePayment(payment.id).catch((error) => {
      console.error(
        `Refund of payment ${payment.id}: Toss canceled it, but reconciling failed`,
        error,
      );
      return null;
    });
  }
  await stopRecurringBilling(payment.user_id);
  // Whichever of this refund, its own reconciliation or the webhook it set
  // off got there first, the plan that was running is what the supporter
  // asked about.
  const subscriptionCanceled =
    planRunningBefore != null &&
    (await runningPlanId(payment.user_id)) !== planRunningBefore;

  return {
    paymentId: payment.id,
    amount: payment.amount,
    subscriptionCanceled,
  };
}
