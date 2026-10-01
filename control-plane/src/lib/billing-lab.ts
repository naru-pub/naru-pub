import { NextRequest } from "next/server";
import { db } from "@/lib/database";
import { deleteRetiredBillingKeys } from "@/lib/billing-keys";
import { reconcilePayment } from "@/lib/payment-reconciliation";
import { refundPayment } from "@/lib/refunds";
import { chargeDueSubscriptions } from "@/lib/subscription-renewals";
import { PAYMENT_GRACE_DAYS } from "@/lib/subscriptions";
import {
  deleteBillingKey,
  isTossTestMode,
  maskSecret,
  TossApiError,
  TossCallRecord,
  withTossLab,
} from "@/lib/toss";
import { POST as tossWebhook } from "@/app/(main)/api/webhooks/toss/route";

// The billing lab runs the real billing code on demand against Toss's test
// API — the renewal charge, reconciliation, refunds, webhooks — and reports
// what Toss answered and what 나루 changed. It exists only in test mode
// (isTossTestMode): every action that charges or refunds goes to Toss for
// real, so with a live key it would move real money.

const DAY_MS = 24 * 60 * 60 * 1000;

// Errors Toss documents for the billing charge API, to force with
// TossPayments-Test-Code. The status decides how 나루 treats the outcome: a
// 4xx is a definitive failure (counted), a 5xx is ambiguous (kept pending).
export const LAB_TEST_CODES = [
  { code: "", label: "정상 응답" },
  { code: "REJECT_CARD_PAYMENT", label: "403 한도초과·잔액부족" },
  { code: "REJECT_CARD_COMPANY", label: "403 카드사 승인 거절" },
  { code: "INVALID_STOPPED_CARD", label: "400 정지된 카드" },
  { code: "PROVIDER_ERROR", label: "400 일시적인 오류" },
  { code: "FAILED_CARD_COMPANY", label: "500 카드사 점검 (불분명)" },
] as const;

export type LabAction =
  | { action: "inspect"; userId: string }
  | { action: "charge"; subscriptionId: string; testCode?: string }
  | {
      action: "advance";
      subscriptionId: string;
      to: "period_end" | "past_grace";
    }
  | { action: "reconcile"; paymentId: string; testCode?: string }
  | { action: "refund"; paymentId: string; testCode?: string }
  | { action: "payment-webhook"; paymentId: string }
  | { action: "billing-deleted"; subscriptionId: string }
  | { action: "process-key-queue"; userId?: string };

type Row = Record<string, string | number | boolean | null>;

export type LabSnapshot = {
  user: Row | null;
  subscription: Row | null;
  payments: Row[];
  retiredKeys: Row[];
};

export type LabResult = {
  ok: boolean;
  message: string;
  calls: TossCallRecord[];
  before: LabSnapshot | null;
  after: LabSnapshot | null;
};

export class LabError extends Error {}

function withoutKey<T extends { toss_billing_key: string | null }>(
  row: T,
): Omit<T, "toss_billing_key"> {
  const rest: Partial<T> = { ...row };
  delete rest.toss_billing_key;
  return rest as Omit<T, "toss_billing_key">;
}

function plain(row: Record<string, unknown>): Row {
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [
      key,
      value instanceof Date
        ? value.toISOString()
        : typeof value === "bigint"
          ? Number(value)
          : (value as Row[string]),
    ]),
  );
}

export async function labSnapshot(userId: string): Promise<LabSnapshot> {
  const user = await db
    .selectFrom("users")
    .select(["id", "login_name", "supporter_comp", "supporter_until"])
    .where("id", "=", userId)
    .executeTakeFirst();
  const subscription = await db
    .selectFrom("subscriptions")
    .select([
      "id",
      "status",
      "billing_interval",
      "amount",
      "toss_billing_key",
      "current_period_start",
      "current_period_end",
      "next_billing_at",
      "failed_charge_count",
      "charging_started_at",
      "canceled_at",
      "renewal_notice_sent_at",
      "payment_grace_notice_sent_at",
    ])
    .where("user_id", "=", userId)
    .executeTakeFirst();
  const payments = await db
    .selectFrom("payments")
    .select([
      "id",
      "attempt_key",
      "order_id",
      "status",
      "amount",
      "refunded_amount",
      "paid_at",
      "period_start",
      "period_end",
      "toss_payment_key",
      "reconciliation_error",
      "created_at",
    ])
    .where("user_id", "=", userId)
    .orderBy("id", "desc")
    .limit(12)
    .execute();
  // The queue is not tied to a user; in a test environment it is short.
  const retiredKeys = await db
    .selectFrom("retired_billing_keys")
    .select(["id", "billing_key", "attempts", "last_error"])
    .orderBy("id", "desc")
    .limit(10)
    .execute();

  return {
    user: user ? plain(user) : null,
    subscription: subscription
      ? plain({
          ...withoutKey(subscription),
          // Shown masked, under a name of its own: this is a display, not a
          // write to the column (billing-key-writes-payment.test.ts).
          billing_key: subscription.toss_billing_key
            ? maskSecret(subscription.toss_billing_key)
            : null,
        })
      : null,
    payments: payments.map((payment) =>
      plain({
        ...payment,
        toss_payment_key: payment.toss_payment_key
          ? maskSecret(payment.toss_payment_key)
          : null,
      }),
    ),
    retiredKeys: retiredKeys.map((row) =>
      plain({ ...row, billing_key: maskSecret(row.billing_key) }),
    ),
  };
}

async function subscriptionOwner(subscriptionId: string) {
  const row = await db
    .selectFrom("subscriptions")
    .select(["user_id", "status", "toss_billing_key", "current_period_end"])
    .where("id", "=", subscriptionId)
    .executeTakeFirst();
  if (!row) throw new LabError("구독을 찾을 수 없습니다.");
  return row;
}

async function paymentOwner(paymentId: string) {
  const row = await db
    .selectFrom("payments")
    .select(["user_id", "order_id"])
    .where("id", "=", paymentId)
    .executeTakeFirst();
  if (!row) throw new LabError("결제를 찾을 수 없습니다.");
  return row;
}

// Replays a webhook through the real handler, as if from Toss's first
// published address — the handler is the code under test, not its sender.
async function replayWebhook(body: unknown) {
  const response = await tossWebhook(
    new NextRequest("http://localhost/api/webhooks/toss", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "cf-connecting-ip": "13.124.18.147",
      },
      body: JSON.stringify(body),
    }),
  );
  return `웹훅 처리 결과: HTTP ${response.status} ${await response.text()}`;
}

// Runs one action. Returns the owning user's snapshot from before and after,
// with every Toss call the action made.
export async function runLabAction(input: LabAction): Promise<LabResult> {
  if (!isTossTestMode()) {
    throw new LabError("테스트 키(test_…)로 설정된 환경에서만 쓸 수 있습니다.");
  }

  let userId: string | null = null;
  let testCode: string | undefined;
  let run: () => Promise<string>;

  switch (input.action) {
    case "inspect":
      userId = input.userId;
      run = async () => "현재 상태입니다.";
      break;

    case "charge": {
      const sub = await subscriptionOwner(input.subscriptionId);
      userId = sub.user_id;
      testCode = input.testCode;
      if (!["active", "scheduled"].includes(sub.status)) {
        throw new LabError(
          `${sub.status} 구독은 갱신 대상이 아닙니다 (active 또는 scheduled만).`,
        );
      }
      if (!sub.toss_billing_key) {
        throw new LabError("빌링키가 없는 구독입니다.");
      }
      run = async () => {
        // Due now, and the lease freed in case an earlier run left one.
        await db
          .updateTable("subscriptions")
          .set({ next_billing_at: new Date(), charging_started_at: null })
          .where("id", "=", input.subscriptionId)
          .execute();
        await chargeDueSubscriptions(new Date(), {
          subscriptionIds: [input.subscriptionId],
        });
        return "갱신 청구를 실행했습니다 (cron과 같은 코드).";
      };
      break;
    }

    case "advance": {
      const sub = await subscriptionOwner(input.subscriptionId);
      userId = sub.user_id;
      run = async () => {
        // Moves the subscription's clock, not the world's: the period ends
        // now, or ended a day past the grace period.
        const periodEnd =
          input.to === "period_end"
            ? new Date()
            : new Date(Date.now() - (PAYMENT_GRACE_DAYS + 1) * DAY_MS);
        await db.transaction().execute(async (trx) => {
          await trx
            .updateTable("subscriptions")
            .set({
              current_period_end: periodEnd,
              next_billing_at: periodEnd,
              charging_started_at: null,
              updated_at: new Date(),
            })
            .where("id", "=", input.subscriptionId)
            .execute();
          await trx
            .updateTable("users")
            .set({ supporter_until: periodEnd })
            .where("id", "=", sub.user_id)
            .execute();
        });
        return input.to === "period_end"
          ? "결제 기간이 지금 끝나도록 옮겼습니다."
          : `결제 기간이 유예 기간(${PAYMENT_GRACE_DAYS}일)보다 하루 더 전에 끝난 것으로 옮겼습니다.`;
      };
      break;
    }

    case "reconcile": {
      userId = (await paymentOwner(input.paymentId)).user_id;
      testCode = input.testCode;
      run = async () => {
        const result = await reconcilePayment(input.paymentId);
        return `대사 결과: ${JSON.stringify(result)}`;
      };
      break;
    }

    case "refund": {
      userId = (await paymentOwner(input.paymentId)).user_id;
      testCode = input.testCode;
      run = async () => {
        const result = await refundPayment({
          paymentId: input.paymentId,
          overridePolicy: true,
          reason: "결제 실험실 테스트 환불",
        });
        return `환불 결과: ${JSON.stringify(result)}`;
      };
      break;
    }

    case "payment-webhook": {
      const payment = await paymentOwner(input.paymentId);
      userId = payment.user_id;
      run = () =>
        replayWebhook({
          eventType: "PAYMENT_STATUS_CHANGED",
          createdAt: new Date().toISOString(),
          data: { orderId: payment.order_id },
        });
      break;
    }

    case "billing-deleted": {
      const sub = await subscriptionOwner(input.subscriptionId);
      userId = sub.user_id;
      const billingKey = sub.toss_billing_key;
      if (!billingKey) throw new LabError("빌링키가 없는 구독입니다.");
      run = async () => {
        // As when the card is removed outside 나루: the key is deleted at
        // Toss first, then Toss sends BILLING_DELETED. Deleting it a second
        // time shows how Toss answers for a key it no longer has, which its
        // docs leave open (alreadyGone in lib/billing-keys.ts relies on it).
        await deleteBillingKey(billingKey);
        let secondDelete = "두 번째 삭제: 성공";
        try {
          await deleteBillingKey(billingKey);
        } catch (error) {
          secondDelete =
            error instanceof TossApiError
              ? `두 번째 삭제: HTTP ${error.status} ${error.code ?? ""}`
              : `두 번째 삭제: ${String(error)}`;
        }
        const webhook = await replayWebhook({
          eventType: "BILLING_DELETED",
          createdAt: new Date().toISOString(),
          data: { billingKey, reason: "billing lab" },
        });
        return `${secondDelete}. ${webhook}`;
      };
      break;
    }

    case "process-key-queue":
      // Not tied to an account; the selected one is shown alongside.
      userId = input.userId ?? null;
      run = async () => {
        // A far-future clock skips the retry backoff for this one run.
        const result = await deleteRetiredBillingKeys(
          new Date(Date.now() + 365 * DAY_MS),
        );
        return `삭제 대기열: ${JSON.stringify(result)}`;
      };
      break;
  }

  const before = userId ? await labSnapshot(userId) : null;
  const outcome = await withTossLab({ testCode }, run);
  const after = userId ? await labSnapshot(userId) : null;

  const error = outcome.error;
  return {
    ok: error == null,
    message:
      error == null
        ? (outcome.result ?? "")
        : error instanceof TossApiError
          ? `Toss 오류: HTTP ${error.status} ${error.code ?? ""} ${error.message}`
          : error instanceof Error
            ? `오류: ${error.message}`
            : `오류: ${String(error)}`,
    calls: outcome.calls,
    before,
    after,
  };
}

// The accounts the lab can act on: everyone with a subscription or a payment.
export async function labAccounts() {
  const rows = await db
    .selectFrom("users")
    .leftJoin("subscriptions", "subscriptions.user_id", "users.id")
    .select([
      "users.id as userId",
      "users.login_name as loginName",
      "subscriptions.id as subscriptionId",
      "subscriptions.status as subscriptionStatus",
    ])
    .where((eb) =>
      eb.or([
        eb("subscriptions.id", "is not", null),
        eb.exists(
          eb
            .selectFrom("payments")
            .select("payments.id")
            .whereRef("payments.user_id", "=", "users.id"),
        ),
      ]),
    )
    .orderBy("users.login_name")
    .limit(200)
    .execute();
  return rows;
}
