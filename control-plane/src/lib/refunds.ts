import { db } from "@/lib/database";
import { reconcilePayment } from "@/lib/payment-reconciliation";
import { cancelPayment, TossApiError } from "@/lib/toss";

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

// 7일 안이면 끝이다. 후원자 전용 기능을 썼는지는 묻지 않는다 — 무엇을 물어야
// 하는지가 곧 무엇을 증명하라는 요구가 되고, 환불을 받을 사람이 자기 사용
// 기록을 해명하게 만드는 창구는 환불 창구가 아니기 때문이다. 사용 기록은
// supporter_feature_uses에 그대로 남아 /admin에서 보이지만, 판정에는 쓰지
// 않는다.
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
    const eligibility = refundEligibility({
      status: payment.status,
      paidAt: payment.paid_at,
      refundedAmount: payment.refunded_amount,
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
