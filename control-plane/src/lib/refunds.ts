import { db } from "@/lib/database";
import type { Feature } from "@/lib/entitlements";
import { getSupporterFeatureUses } from "@/lib/feature-usage";
import { reconcilePayment } from "@/lib/payment-reconciliation";
import { cancelPayment, TossApiError } from "@/lib/toss";

// 판매 정책의 환불 조건: 결제일로부터 7일 이내에 후원자 전용 기능을 쓰지
// 않았다면 전액 환불. 이 상수와 아래 판정 함수가 그 문장의 구현이므로,
// components/SupportPolicy의 문구를 고칠 때 함께 고쳐야 한다.
export const REFUND_WINDOW_DAYS = 7;

// 환불 조건을 없애는 '사용'은 결제로 산 것을 실제로 가져간 경우 — 도메인을
// 걸고, 배포를 돌리고, 데이터를 넣은 경우 — 로 한정한다. 방문자 현황은 열어
// 보는 것이 전부인 기능이라, 후원이 값어치를 하는지 한 번 들여다본 것만으로
// 환불을 잃게 하지는 않는다. 사용 기록 자체는 남으므로 /admin에서는 그대로
// 보인다.
export const REFUND_BLOCKING_FEATURES: Feature[] = [
  "custom_domains",
  "github_deploys",
  "database",
];

export function blocksRefund(feature: Feature): boolean {
  return REFUND_BLOCKING_FEATURES.includes(feature);
}

export type RefundBlockReason =
  | "not_paid"
  | "already_refunded"
  | "window_passed"
  | "feature_used";

export type RefundEligibility =
  | { eligible: true; deadline: Date }
  | {
      eligible: false;
      reason: RefundBlockReason;
      message: string;
      usedFeatures?: Feature[];
    };

export type RefundEligibilityInput = {
  status: string;
  paidAt: Date | string | null;
  refundedAmount: number;
  /** Supporter feature ledger for the paying account. */
  featureUses: { feature: Feature; lastUsedAt: Date | string }[];
  now?: Date;
};

export function refundDeadline(paidAt: Date | string): Date {
  const deadline = new Date(paidAt);
  deadline.setDate(deadline.getDate() + REFUND_WINDOW_DAYS);
  return deadline;
}

// A user may refund their own payment only while the promise in the sales
// policy still holds. Operators are not bound by this — an outage refund, or
// any other 최종 판단, is theirs to make — so the rule lives here rather than
// inside the endpoint that both of them call.
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

  const paidAt = new Date(input.paidAt);
  const deadline = refundDeadline(paidAt);
  if (now.getTime() > deadline.getTime()) {
    return {
      eligible: false,
      reason: "window_passed",
      message: `결제일로부터 ${REFUND_WINDOW_DAYS}일이 지나 환불할 수 없습니다.`,
    };
  }

  // Using a supporter feature after paying consumes what the payment bought,
  // so the "쓰지 않으셨다면" condition is measured from this payment's date
  // rather than from the account's first ever use. Only the features that
  // actually hand something over count — see REFUND_BLOCKING_FEATURES.
  const usedFeatures = input.featureUses
    .filter(
      (use) =>
        blocksRefund(use.feature) &&
        new Date(use.lastUsedAt).getTime() >= paidAt.getTime(),
    )
    .map((use) => use.feature);
  if (usedFeatures.length > 0) {
    return {
      eligible: false,
      reason: "feature_used",
      message: "결제 후 후원자 전용 기능을 사용하셔서 환불할 수 없습니다.",
      usedFeatures,
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

// Refunding ends the billing relationship, not just this one charge: whatever
// bought the refunded period must not charge the card again. Reconciliation
// already cancels the subscription that a refunded renewal belongs to, but a
// refunded one-time donation has no subscription of its own, so the account's
// recurring plan is stopped here as well.
async function stopRecurringBilling(userId: number): Promise<boolean> {
  const result = await db
    .updateTable("subscriptions")
    .set({
      status: "canceled",
      toss_billing_key: null,
      next_billing_at: null,
      charging_started_at: null,
      canceled_at: new Date(),
      updated_at: new Date(),
    })
    .where("user_id", "=", userId)
    .where("status", "not in", ["canceled", "switched_to_one_time"])
    .executeTakeFirst();
  return Number(result.numUpdatedRows ?? 0) > 0;
}

export type RefundOutcome = {
  paymentId: number;
  amount: number;
  subscriptionCanceled: boolean;
};

// Performs the refund end to end: cancel at Toss, then re-read the payment from
// Toss so the ledger, supporter_until and the subscription all move in the one
// reconciliation path that every other refund (webhook, daily sync) goes
// through.
export async function refundPayment(opts: {
  paymentId: number;
  /** Operators may refund outside the policy window; owners may not. */
  overridePolicy: boolean;
  reason: string;
}): Promise<RefundOutcome> {
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
    const featureUses = await getSupporterFeatureUses(payment.user_id);
    const eligibility = refundEligibility({
      status: payment.status,
      paidAt: payment.paid_at,
      refundedAmount: payment.refunded_amount,
      featureUses,
    });
    if (!eligibility.eligible) {
      throw new RefundError(eligibility.message, 409);
    }
  }

  try {
    await cancelPayment({
      paymentKey: payment.toss_payment_key,
      cancelReason: opts.reason.slice(0, 200),
      idempotencyKey: `refund:${payment.id}`,
    });
  } catch (error) {
    // The money is already back — it is the ledger that is behind. Fall through
    // to reconciliation so this attempt catches the ledger up instead of
    // reporting a failure for a refund that did happen.
    if (
      !(error instanceof TossApiError) ||
      error.code !== "ALREADY_CANCELED_PAYMENT"
    ) {
      throw error;
    }
  }

  await reconcilePayment(payment.id);
  const subscriptionCanceled = await stopRecurringBilling(payment.user_id);

  return {
    paymentId: payment.id,
    amount: payment.amount,
    subscriptionCanceled,
  };
}
