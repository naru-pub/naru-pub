import { AccountBusyError, withAccountLock } from "@/lib/payments/account-lock";
import { db } from "@/lib/database";
import { enqueueJob } from "@/lib/payments/payment-jobs";
import { LIVE_SUBSCRIPTION_STATUSES } from "@/lib/payments/payment-states";
import { isTossTestMode, paymentOfOtherMid } from "@/lib/payments/toss";

// 판매 정책의 환불 조건: 결제일로부터 7일 안에는 이유를 묻지 않고 전액 환불.
// 이 상수와 아래 판정 함수가 그 문장의 구현이므로, components/SupportPolicy의
// 문구를 고칠 때 함께 고쳐야 한다.
export const REFUND_WINDOW_DAYS = 7;

export type RefundBlockReason =
  | "not_paid"
  | "already_refunded"
  | "other_mid"
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
  // Made through another Toss MID than the current key's
  // (lib/payments/toss, paymentOfOtherMid): Toss cannot cancel it from here.
  otherMid?: boolean;
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
  if (input.otherMid) {
    return {
      eligible: false,
      reason: "other_mid",
      message: "이전 결제 설정으로 이루어진 결제라 여기서 환불할 수 없습니다.",
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

export type RefundProgress = {
  paymentId: string;
  amount: number;
  state: "not_requested" | "pending" | "completed" | "failed";
};

export async function refundProgress(
  paymentId: string,
): Promise<RefundProgress> {
  const payment = await readRefundPayment(paymentId);
  if (!payment) throw new RefundError("결제 내역을 찾을 수 없습니다.", 404);
  const task = payment.refund_requested_at
    ? await db
        .selectFrom("absurd.t_payments")
        .select("state")
        .where("idempotency_key", "=", `refund:${paymentId}`)
        .executeTakeFirst()
    : undefined;
  return {
    paymentId,
    amount: payment.amount,
    state:
      payment.refunded_amount > 0
        ? "completed"
        : !payment.refund_requested_at
          ? "not_requested"
          : task?.state === "failed" || task?.state === "cancelled"
            ? "failed"
            : "pending",
  };
}

// HTTP only accepts the request and commits its task. Only the Absurd handler
// in payment-jobs cancels at Toss; eligibility belongs to acceptance, not worker retries.
type RefundRequest = {
  paymentId: string;
  /** Operators may refund outside the policy window; owners may not. */
  overridePolicy: boolean;
  reason: string;
  testCode?: string;
};

// Runs under the account lock (lib/payments/account-lock): a second click, the
// webhook of this very cancel, or a renewal waits for it to finish.
export async function requestRefund(
  opts: RefundRequest,
): Promise<RefundProgress> {
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

export function readRefundPayment(paymentId: string) {
  return db
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
      "toss_mid",
      "refund_requested_at",
      "refund_subscription_id",
    ])
    .where("id", "=", paymentId)
    .executeTakeFirst();
}

async function refundLocked(opts: RefundRequest): Promise<RefundProgress> {
  const payment = await readRefundPayment(opts.paymentId);
  if (!payment) throw new RefundError("결제 내역을 찾을 수 없습니다.", 404);

  // Repeated requests return the durable intention, even after its policy deadline.
  if (payment.refund_requested_at) return refundProgress(payment.id);
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

  // Not even for an operator: Toss would refuse the cancel.
  const otherMid = paymentOfOtherMid(payment);
  if (otherMid) throw new RefundError(otherMid.message, 409);

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

  // Acceptance and its task commit together before touching Toss. Capture
  // the subscription now: recovery must never cancel a later signup.
  if (!payment.refund_requested_at) {
    await db.transaction().execute(async (trx) => {
      await trx
        .updateTable("payments")
        .set({
          refund_requested_at: new Date(),
          refund_subscription_id: planRunningBefore,
        })
        .where("id", "=", payment.id)
        .execute();
      await enqueueJob(
        trx,
        {
          kind: "refund_payment",
          paymentId: payment.id,
          reason: opts.reason.slice(0, 200),
          ...(opts.testCode && isTossTestMode()
            ? { testCode: opts.testCode.slice(0, 100) }
            : {}),
        },
        { dedupeKey: `refund:${payment.id}` },
      );
    });
  }
  return { paymentId: payment.id, amount: payment.amount, state: "pending" };
}
