import { randomInt } from "crypto";

const TOSS_API = "https://api.tosspayments.com";

export type BillingInterval = "month" | "year";

// Authoritative server-side amounts (KRW). Never trust client-sent amounts.
export const PLAN_AMOUNTS: Record<BillingInterval, number> = {
  month: 1000,
  year: 10000,
};

export const PLAN_ORDER_NAMES: Record<BillingInterval, string> = {
  month: "나루 후원 (월간)",
  year: "나루 후원 (연간)",
};

// One-time donation: pay once for 1 year (no auto-renewal). Priced above the
// recurring annual plan since there's no retention commitment.
export const ONE_TIME_YEAR_AMOUNT = 12000;
export const ONE_TIME_YEAR_ORDER_NAME = "나루 후원 (1년, 한 번만 결제)";

// Card-company review (PG 심사) rejects a merchant whose 서비스 제공기간 runs
// longer than a year, so nothing over one year may be sold any more.
export const MAX_PURCHASABLE_ONE_TIME_YEARS = 1;

// Multi-year purchases were sold before that rule was applied. Reading a stored
// amount back — confirming a pending payment, reconciling a refund — still has
// to resolve those rows, so the parse bound stays where it was.
export const MAX_ONE_TIME_YEARS = 10;

export function isOneTimeYears(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= MAX_ONE_TIME_YEARS
  );
}

// The bound for a *new* purchase, as opposed to reading an existing one.
export function isPurchasableOneTimeYears(value: unknown): value is number {
  return isOneTimeYears(value) && value <= MAX_PURCHASABLE_ONE_TIME_YEARS;
}

export function oneTimeAmount(years: number): number {
  if (!isOneTimeYears(years)) throw new Error("Invalid one-time support years");
  return ONE_TIME_YEAR_AMOUNT * years;
}

export function oneTimeYearsForAmount(amount: number): number | null {
  const years = amount / ONE_TIME_YEAR_AMOUNT;
  return isOneTimeYears(years) ? years : null;
}

export function oneTimeOrderName(years: number): string {
  if (!isOneTimeYears(years)) throw new Error("Invalid one-time support years");
  return `나루 후원 (${years}년, 한 번만 결제)`;
}

export function isBillingInterval(value: unknown): value is BillingInterval {
  return value === "month" || value === "year";
}

export class TossApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code?: string,
  ) {
    super(message);
    this.name = "TossApiError";
  }
}

// A response-level 4xx (except an in-progress idempotency conflict) means Toss
// definitively rejected the request. Network failures, 5xx and 409 are
// ambiguous and must be reconciled with the same order/idempotency key.
export function isDefinitiveTossFailure(error: unknown): error is TossApiError {
  return (
    error instanceof TossApiError &&
    error.status >= 400 &&
    error.status < 500 &&
    error.status !== 409
  );
}

function authHeader(): string {
  const secret = process.env.TOSS_SECRET_KEY;
  if (!secret) {
    throw new Error("TOSS_SECRET_KEY is not configured.");
  }
  // Toss uses HTTP Basic auth with the secret key as username and empty password.
  return "Basic " + Buffer.from(`${secret}:`).toString("base64");
}

async function tossRequest<T>(
  path: string,
  init: {
    method?: "GET" | "POST";
    body?: unknown;
    idempotencyKey?: string;
  } = {},
): Promise<T> {
  const res = await fetch(`${TOSS_API}${path}`, {
    method: init.method ?? "POST",
    headers: {
      Authorization: authHeader(),
      "Content-Type": "application/json",
      ...(init.idempotencyKey
        ? { "Idempotency-Key": init.idempotencyKey }
        : {}),
    },
    body: init.body == null ? undefined : JSON.stringify(init.body),
  });

  const data = (await res.json()) as Record<string, unknown>;
  if (!res.ok) {
    throw new TossApiError(
      (data?.message as string) ?? `Toss API request failed (${res.status})`,
      res.status,
      data?.code as string | undefined,
    );
  }
  return data as T;
}

export type TossBillingKeyResult = {
  billingKey: string;
  customerKey: string;
};

// Exchanges the authKey from requestBillingAuth for a reusable billing key.
export function issueBillingKey(authKey: string, customerKey: string) {
  return tossRequest<TossBillingKeyResult>("/v1/billing/authorizations/issue", {
    body: { authKey, customerKey },
  });
}

export type TossPaymentResult = {
  paymentKey: string;
  orderId: string;
  status: string; // "DONE" on success
  totalAmount: number;
  balanceAmount?: number;
  cancels?: Array<{
    cancelAmount: number;
    canceledAt?: string;
    transactionKey?: string;
  }> | null;
  approvedAt?: string;
  [key: string]: unknown;
};

// Charges a stored billing key for one period.
export function chargeBillingKey(params: {
  billingKey: string;
  customerKey: string;
  amount: number;
  orderId: string;
  orderName: string;
  idempotencyKey: string;
}) {
  const { billingKey, idempotencyKey, ...body } = params;
  return tossRequest<TossPaymentResult>(`/v1/billing/${billingKey}`, {
    body,
    idempotencyKey,
  });
}

// Finalizes a one-time payment (non-billing). Toss validates that paymentKey,
// orderId and amount match what was requested in requestPayment.
export function confirmPayment(
  params: { paymentKey: string; orderId: string; amount: number },
  idempotencyKey: string,
) {
  return tossRequest<TossPaymentResult>("/v1/payments/confirm", {
    body: params,
    idempotencyKey,
  });
}

// Cancels a payment, refunding it in full. 나루 does not sell partial periods
// back, so no cancelAmount is sent: Toss refunds the whole balance. Passing the
// same idempotency key for a retry cancels once rather than twice.
export function cancelPayment(params: {
  paymentKey: string;
  cancelReason: string;
  idempotencyKey: string;
}) {
  const { paymentKey, cancelReason, idempotencyKey } = params;
  return tossRequest<TossPaymentResult>(
    `/v1/payments/${encodeURIComponent(paymentKey)}/cancel`,
    { body: { cancelReason }, idempotencyKey },
  );
}

export function getPaymentByOrderId(orderId: string) {
  return tossRequest<TossPaymentResult>(
    `/v1/payments/orders/${encodeURIComponent(orderId)}`,
    { method: "GET" },
  );
}

export function addInterval(from: Date, interval: BillingInterval): Date {
  const d = new Date(from);
  if (interval === "month") {
    d.setMonth(d.getMonth() + 1);
  } else {
    d.setFullYear(d.getFullYear() + 1);
  }
  return d;
}

// 주문번호는 두 곳에서 모양이 정해진다. 좁은 화면의 결제 내역 한 줄과,
// 전화로 불러 주는 순간. 그래서 숫자만 쓰고 끊어 읽게 만든다. 한국어로 그냥
// 읽으면 되고, 철자를 되묻을 글자가 아예 없다.
//
// 앞은 KST 결제일을 ISO 날짜 그대로 적는다. 날짜를 날짜로 읽을 수 있어서
// 숫자 여덟 개를 부르는 것보다 안전하다 — 듣는 쪽이 "십삼 월"은 없다는 걸
// 아니까, 자리를 바꿔 들으면 거기서 걸린다. 겹칠 수 있는 범위도 '그날
// 하루'로 좁아져서 뒤의 여덟 자리만으로 충분하다. 하루 200건이면 겹칠
// 확률이 하루 2×10^-4 — 십수 년에 한 번꼴이고, 그마저도 payments.order_id의
// 유니크 인덱스와 Toss가 큰 소리로 거절한다. 결제가 잘못될 일은 없고 실패할
// 뿐이다.
//
// Toss는 6~64자의 [A-Za-z0-9-_]를 받으므로 하이픈까지 그대로 통과한다.
// 하이픈은 보기 좋으라고만 있는 게 아니라, 지원 문의용 스프레드시트가 숫자로
// 읽어 뭉개는 것도 막아 준다. 앞의 0도 그대로 살아남는다.
const ORDER_ID_DATE = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Seoul",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

export function newOrderId(now = new Date()): string {
  // en-CA already formats as YYYY-MM-DD, which is the shape we want to say out
  // loud, so nothing is reassembled here.
  const date = ORDER_ID_DATE.format(now);
  // randomInt is rejection-sampled, so every eight-digit value is equally
  // likely — no bias from folding a random byte into a decimal range.
  const random = String(randomInt(0, 100_000_000)).padStart(8, "0");
  return `${date}-${random.slice(0, 4)}-${random.slice(4)}`;
}
