import { sql, type RawBuilder } from "kysely";
import { PAYMENT_GRACE_DAYS } from "@/lib/subscriptions";

// What each /admin overview card counts, defined once. The card counts with
// the condition and its detail page lists with the same condition, so the
// number on a card is always the number of rows behind it.

const DAY_MS = 24 * 60 * 60 * 1000;

function daysAgo(now: Date, days: number) {
  return new Date(now.getTime() - days * DAY_MS);
}

type Condition = (now: Date) => RawBuilder<boolean>;

export type PaymentFilterKey =
  | "paid_30d"
  | "refunded_30d"
  | "pending"
  | "errors"
  | "failed_7d";

export const PAYMENT_FILTERS: Record<
  PaymentFilterKey,
  { label: string; description: string; condition: Condition }
> = {
  paid_30d: {
    label: "최근 30일 결제",
    description:
      "지난 30일 안에 결제가 완료된 주문입니다. 그 뒤에 환불된 결제도 들어 있습니다.",
    condition: (now) => sql<boolean>`payments.paid_at >= ${daysAgo(now, 30)}`,
  },
  refunded_30d: {
    label: "최근 30일 환불",
    description: "지난 30일 안에 환불이 확인된 결제입니다.",
    condition: (now) =>
      sql<boolean>`payments.refunded_amount > 0 and payments.refunded_at >= ${daysAgo(now, 30)}`,
  },
  pending: {
    label: "대기 중",
    description:
      "결과를 아직 모르는 주문입니다. 5분마다 Toss와 대사하고, Toss에 없는 주문은 30분 뒤 만료합니다.",
    condition: () => sql<boolean>`payments.status = 'pending'`,
  },
  errors: {
    label: "대사 오류",
    description:
      "마지막 대사가 실패한 대기·완료 결제입니다. 진단 칸에 오류가 있습니다.",
    condition: () =>
      sql<boolean>`payments.reconciliation_error is not null and payments.status in ('pending', 'done')`,
  },
  failed_7d: {
    label: "최근 7일 실패",
    description:
      "지난 7일 안에 만든 주문 가운데 Toss가 거절했거나(aborted) 실패로 확정된 주문입니다. 결제창을 닫아 만료된 주문은 빠집니다.",
    condition: (now) =>
      sql<boolean>`payments.status in ('failed', 'aborted') and payments.created_at >= ${daysAgo(now, 7)}`,
  },
};

export function isPaymentFilter(value: unknown): value is PaymentFilterKey {
  return typeof value === "string" && value in PAYMENT_FILTERS;
}

// Has paid features right now: a permanent comp, or paid time that has not
// run past the payment grace window — the rule getUserEntitlement applies.
export const supporterCondition: Condition = (now) =>
  sql<boolean>`(users.supporter_comp or users.supporter_until > ${daysAgo(now, PAYMENT_GRACE_DAYS)})`;

export const SUBSCRIPTION_STATUS_LABELS: Record<string, string> = {
  active: "활성",
  scheduled: "예약",
  incomplete: "가입 중",
  past_due: "연체",
  canceled: "취소",
  switched_to_one_time: "한 번만 결제로 전환",
};

export const WEBHOOK_WINDOWS = {
  "24h": { label: "최근 24시간", ms: DAY_MS },
  "7d": { label: "최근 7일", ms: 7 * DAY_MS },
} as const;

export type WebhookWindow = keyof typeof WEBHOOK_WINDOWS;

export function isWebhookWindow(value: unknown): value is WebhookWindow {
  return typeof value === "string" && value in WEBHOOK_WINDOWS;
}

export function webhookWindowStart(window: WebhookWindow, now = new Date()) {
  return new Date(now.getTime() - WEBHOOK_WINDOWS[window].ms);
}
