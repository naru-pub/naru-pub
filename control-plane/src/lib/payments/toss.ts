import { AsyncLocalStorage } from "async_hooks";
import { createHash, randomInt } from "crypto";

const TOSS_API = "https://api.tosspayments.com";

export type BillingInterval = "month" | "year";
export type TossPaymentFlow = "billing" | "one-time";

// Authoritative server-side amounts (KRW). Never trust client-sent amounts.
export const PLAN_AMOUNTS: Record<BillingInterval, number> = {
  month: 1000,
  year: 10000,
};

export const PLAN_ORDER_NAMES: Record<BillingInterval, string> = {
  month: "나루 결제 (월간)",
  year: "나루 결제 (연간)",
};

// One-time donation: pay once for 1 year (no auto-renewal). Priced above the
// recurring annual plan since there's no retention commitment.
export const ONE_TIME_YEAR_AMOUNT = 12000;
export const ONE_TIME_YEAR_ORDER_NAME = "나루 결제 (1년, 한 번만 결제)";

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
  return `나루 결제 (${years}년, 한 번만 결제)`;
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

// 4xx answers that say nothing about the card: a temporary fault at Toss
// (PROVIDER_ERROR: "잠시 후 다시 시도"), a request for this order already in
// flight or already approved, or 나루's own keys or requests being wrong — a
// billing charge's customerKey that is not the one the key was issued for, a
// malformed body. Counting one of these as a decline would fail a payment Toss
// may have approved, or count a bug of 나루's against every subscriber's card.
// https://docs.tosspayments.com/reference/error-codes
const NOT_A_DECLINE_CODES = new Set([
  "INVALID_REQUEST",
  "NOT_MATCHES_CUSTOMER_KEY",
  "PROVIDER_ERROR",
  "ALREADY_PROCESSING_REQUEST",
  "ALREADY_PROCESSED_PAYMENT",
  "DUPLICATED_ORDER_ID",
  "DUPLICATED_REQUEST",
  "FORBIDDEN_CONSECUTIVE_REQUEST",
  "FORBIDDEN_REQUEST",
  "UNAUTHORIZED_KEY",
  "INVALID_API_KEY",
  "INCORRECT_BASIC_AUTH_FORMAT",
  "NOT_SUPPORTED_METHOD",
]);

// True when Toss refused the request on its merits — a declined card, an
// expired authKey. Network failures, 5xx, 401, 409 (the same idempotency key
// still in flight), 429 and the codes above are ambiguous and must be
// reconciled with the same order and idempotency key.
export function isDefinitiveTossFailure(error: unknown): error is TossApiError {
  return (
    error instanceof TossApiError &&
    error.status >= 400 &&
    error.status < 500 &&
    error.status !== 401 &&
    error.status !== 409 &&
    error.status !== 429 &&
    !NOT_A_DECLINE_CODES.has(error.code ?? "")
  );
}

export function describeTossError(error: unknown): string {
  if (error instanceof TossApiError) {
    return `${error.code ?? error.status} ${error.message}`;
  }
  return error instanceof Error ? error.message : String(error);
}

function secretKey(flow: TossPaymentFlow): string | undefined {
  return flow === "billing"
    ? process.env.TOSS_BILLING_SECRET_KEY
    : process.env.TOSS_PAYMENT_SECRET_KEY;
}

// The secret keys configured, by flow. Only for checking webhook signatures
// in this process; never logged or sent anywhere.
export function tossSecretKeys(): Array<{
  flow: TossPaymentFlow;
  key: string;
}> {
  return (["billing", "one-time"] as const).flatMap((flow) => {
    const key = secretKey(flow);
    return key ? [{ flow, key }] : [];
  });
}

// True only when Toss keys are configured and every one is a live key
// (live_…): the environment where real money moves, i.e. production.
export function isTossLiveMode(): boolean {
  const keys = [
    process.env.TOSS_BILLING_SECRET_KEY,
    process.env.TOSS_PAYMENT_SECRET_KEY,
  ].filter((key): key is string => Boolean(key));
  return keys.length > 0 && keys.every((key) => key.startsWith("live_"));
}

// True only when every configured Toss key is a test key (test_…), so nothing
// done here can move real money. The billing lab exists only then.
export function isTossTestMode(): boolean {
  const keys = [
    process.env.TOSS_BILLING_SECRET_KEY,
    process.env.TOSS_PAYMENT_SECRET_KEY,
  ].filter((key): key is string => Boolean(key));
  return keys.length > 0 && keys.every((key) => key.startsWith("test_"));
}

// One Toss API call as the billing lab shows it.
export type TossCallRecord = {
  flow: TossPaymentFlow;
  method: string;
  path: string;
  testCode: string | null;
  requestBody: unknown;
  status: number | null;
  responseBody: unknown;
  error: string | null;
  durationMs: number;
};

type TossLabContext = { testCode: string | null; calls: TossCallRecord[] };
const labContext = new AsyncLocalStorage<TossLabContext>();

// Runs fn with every Toss call it makes recorded and, in test mode, with
// TossPayments-Test-Code set so Toss answers with that error instead
// (https://docs.tosspayments.com/resources/faq). Toss ignores the header for
// live keys; it is not even sent unless the key in use is a test key.
// Outside this, tossRequest behaves exactly as before.
export async function withTossLab<T>(
  opts: { testCode?: string | null },
  fn: () => Promise<T>,
): Promise<{ result: T | null; error: unknown; calls: TossCallRecord[] }> {
  const context: TossLabContext = {
    testCode: opts.testCode || null,
    calls: [],
  };
  try {
    const result = await labContext.run(context, fn);
    return { result, error: null, calls: context.calls };
  } catch (error) {
    return { result: null, error, calls: context.calls };
  }
}

// Billing keys are long-lived card credentials, so a recorded call shows only
// enough of one to tell keys apart.
export function maskSecret(value: string): string {
  return value.length <= 8
    ? "••••"
    : `${value.slice(0, 4)}••••${value.slice(-4)}`;
}

const MASKED_FIELDS = new Set(["billingKey", "secret", "authKey"]);

export function maskBody(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(maskBody);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, field]) => [
        key,
        MASKED_FIELDS.has(key) && typeof field === "string"
          ? maskSecret(field)
          : maskBody(field),
      ]),
    );
  }
  return value;
}

function maskPath(path: string): string {
  return path.replace(
    /^\/v1\/billing\/(?!authorizations\/)([^/?]+)/,
    (_, key: string) => `/v1/billing/${maskSecret(decodeURIComponent(key))}`,
  );
}

function authHeader(flow: TossPaymentFlow): string {
  const secret = secretKey(flow);
  if (!secret) {
    throw new Error(
      flow === "billing"
        ? "TOSS_BILLING_SECRET_KEY is not configured."
        : "TOSS_PAYMENT_SECRET_KEY is not configured.",
    );
  }
  // Toss uses HTTP Basic auth with the secret key as username and empty password.
  return "Basic " + Buffer.from(`${secret}:`).toString("base64");
}

// A billing charge can take up to 60 seconds at Toss (자동결제 승인은 최대
// 60초가 소요됩니다). Past this the request is abandoned and, like any transport
// failure, left for the same order and idempotency key to settle later.
const TOSS_REQUEST_TIMEOUT_MS = 90 * 1000;

async function tossRequest<T>(
  flow: TossPaymentFlow,
  path: string,
  init: {
    method?: "GET" | "POST" | "DELETE";
    body?: unknown;
    idempotencyKey?: string;
  } = {},
): Promise<T> {
  const lab = labContext.getStore();
  const testCode =
    lab?.testCode && secretKey(flow)?.startsWith("test_") ? lab.testCode : null;
  const method = init.method ?? "POST";
  // Every call is recorded: shown by the billing lab when it runs inside
  // one, and kept in toss_calls (recordTossCall) either way.
  const record: TossCallRecord = {
    flow,
    method,
    path: maskPath(path),
    testCode,
    requestBody: init.body == null ? null : maskBody(init.body),
    status: null,
    responseBody: null,
    error: null,
    durationMs: 0,
  };
  if (lab) lab.calls.push(record);
  const startedAt = Date.now();
  try {
    return await sendTossRequest<T>(flow, path, init, method, testCode, record);
  } finally {
    record.durationMs = Date.now() - startedAt;
    await tossCallRecorder?.(record, orderIdOf(path, init.body));
  }
}

// Where calls are kept (toss_calls), set by lib/payments/toss-calls.ts so this module
// stays free of the database; unset (unit tests, scripts) nothing is kept.
type TossCallRecorder = (
  record: TossCallRecord,
  orderId: string | null,
) => Promise<void>;
let tossCallRecorder: TossCallRecorder | null = null;

export function setTossCallRecorder(recorder: TossCallRecorder | null) {
  tossCallRecorder = recorder;
}

function orderIdOf(path: string, body: unknown): string | null {
  const fromBody =
    body && typeof body === "object"
      ? (body as { orderId?: unknown }).orderId
      : undefined;
  if (typeof fromBody === "string") return fromBody;
  const match = /^\/v1\/payments\/orders\/([^/?]+)/.exec(path);
  return match ? decodeURIComponent(match[1]) : null;
}

async function sendTossRequest<T>(
  flow: TossPaymentFlow,
  path: string,
  init: { body?: unknown; idempotencyKey?: string },
  method: string,
  testCode: string | null,
  record: TossCallRecord,
): Promise<T> {
  const startedAt = Date.now();

  let res: Response;
  try {
    res = await fetch(`${TOSS_API}${path}`, {
      method,
      headers: {
        Authorization: authHeader(flow),
        "Content-Type": "application/json",
        ...(init.idempotencyKey
          ? { "Idempotency-Key": init.idempotencyKey }
          : {}),
        ...(testCode ? { "TossPayments-Test-Code": testCode } : {}),
      },
      body: init.body == null ? undefined : JSON.stringify(init.body),
      signal: AbortSignal.timeout(TOSS_REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    record.error = error instanceof Error ? error.message : String(error);
    record.durationMs = Date.now() - startedAt;
    throw error;
  }
  record.status = res.status;
  record.durationMs = Date.now() - startedAt;

  // A gateway in front of Toss can answer with an HTML error page. That is
  // still a response with a status, so it must surface as a TossApiError (a 5xx
  // stays ambiguous) rather than a SyntaxError that callers mistake for their
  // own bad input.
  let data: Record<string, unknown>;
  try {
    const text = await res.text();
    record.responseBody = text.slice(0, 4000);
    // A successful DELETE may answer with no body at all.
    data = (text ? JSON.parse(text) : {}) as Record<string, unknown>;
    record.responseBody = maskBody(data);
  } catch {
    throw new TossApiError(
      `Toss API returned an unreadable response (${res.status})`,
      res.ok ? 502 : res.status,
    );
  }
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
  // The card, masked by Toss (e.g. "43301234****123*").
  cardCompany?: string | null;
  cardNumber?: string | null;
};

// Exchanges the authKey from requestBillingAuth for a reusable billing key.
// The authKey works once, so a retry after a lost response must replay the
// first answer instead of asking again: the idempotency key is derived from it
// (hashed, since an authKey may be as long as the 300-character key limit).
export function issueBillingKey(authKey: string, customerKey: string) {
  return tossRequest<TossBillingKeyResult>(
    "billing",
    "/v1/billing/authorizations/issue",
    {
      body: { authKey, customerKey },
      idempotencyKey: `issue-${createHash("sha256").update(authKey).digest("hex")}`,
    },
  );
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
  mId?: string;
  type?: string;
  method?: string | null;
  currency?: string;
  version?: string;
  receipt?: { url?: string } | null;
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
  return tossRequest<TossPaymentResult>(
    "billing",
    `/v1/billing/${encodeURIComponent(billingKey)}`,
    {
      body,
      idempotencyKey,
    },
  );
}

// Finalizes a one-time payment (non-billing). Toss validates that paymentKey,
// orderId and amount match what was requested in requestPayment.
export function confirmPayment(
  params: { paymentKey: string; orderId: string; amount: number },
  idempotencyKey: string,
) {
  return tossRequest<TossPaymentResult>("one-time", "/v1/payments/confirm", {
    body: params,
    idempotencyKey,
  });
}

// Cancels a payment, refunding it in full. 나루 does not sell partial periods
// back, so no cancelAmount is sent: Toss refunds the whole balance.
//
// No idempotency key: Toss stores the first response for a key — errors
// included — and replays it for 15 days, so a fixed key would turn one failed
// cancel into 15 days of the same failure, well past the refund window. A full
// cancel is already safe to repeat: Toss refuses to cancel a payment twice.
export function cancelPayment(params: {
  flow: TossPaymentFlow;
  paymentKey: string;
  cancelReason: string;
}) {
  const { flow, paymentKey, cancelReason } = params;
  return tossRequest<TossPaymentResult>(
    flow,
    `/v1/payments/${encodeURIComponent(paymentKey)}/cancel`,
    { body: { cancelReason } },
  );
}

// Deletes a billing key at Toss so it can never be charged again. A key has no
// expiry of its own beyond its card's ("빌링키의 유효기간은 빌링키와 연결된
// 카드 유효기간과 같습니다"), and Toss cannot renew one: a reissued card needs a
// new key (prepareCardChange).
export async function deleteBillingKey(billingKey: string): Promise<void> {
  await tossRequest<unknown>(
    "billing",
    `/v1/billing/${encodeURIComponent(billingKey)}`,
    { method: "DELETE" },
  );
}

// One movement of money Toss recorded: an approval, or one cancel of it.
export type TossTransaction = {
  mId?: string;
  transactionKey: string;
  paymentKey: string;
  orderId: string;
  status: string;
  transactionAt: string;
  amount: number;
};

// One page of the transactions Toss recorded between two KST times
// (yyyy-MM-ddTHH:mm:ss), after `startingAfter` (a transactionKey).
export function listTransactions(
  flow: TossPaymentFlow,
  params: {
    startDate: string;
    endDate: string;
    startingAfter?: string;
    limit?: number;
  },
) {
  const query = new URLSearchParams({
    startDate: params.startDate,
    endDate: params.endDate,
    limit: String(params.limit ?? 5000),
  });
  if (params.startingAfter) query.set("startingAfter", params.startingAfter);
  return tossRequest<TossTransaction[]>(flow, `/v1/transactions?${query}`, {
    method: "GET",
  });
}

export function getPaymentByOrderId(orderId: string, flow: TossPaymentFlow) {
  return tossRequest<TossPaymentResult>(
    flow,
    `/v1/payments/orders/${encodeURIComponent(orderId)}`,
    { method: "GET" },
  );
}

// Payment rows predate separate MIDs. The attempt key is the durable flow
// marker: one-time donations use one_time:*; all other rows are billing-key
// charges. Keep this mapping in one place so lookup and cancellation use the
// same MID as the original charge.
export function paymentFlowForAttempt(
  attemptKey: string | null,
): TossPaymentFlow {
  return attemptKey?.startsWith("one_time:") ? "one-time" : "billing";
}

export function paymentFlowForRecord(
  flow: string | null,
  attemptKey: string | null,
): TossPaymentFlow {
  return flow === "billing" || flow === "one-time"
    ? flow
    : paymentFlowForAttempt(attemptKey);
}

export function paymentProviderMetadata(
  payment: TossPaymentResult,
  flow: TossPaymentFlow,
) {
  return {
    toss_flow: flow,
    toss_mid: payment.mId ?? null,
    toss_payment_type: payment.type ?? null,
    toss_method: payment.method ?? null,
    toss_currency: payment.currency ?? null,
    toss_approved_at: payment.approvedAt ? new Date(payment.approvedAt) : null,
    toss_receipt_url: payment.receipt?.url ?? null,
    toss_api_version: payment.version ?? null,
  };
}

// Korea has no daylight saving time, so KST is always UTC+9.
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

// Adds whole calendar months, clamping to the target month's last day. Plain
// setMonth overflows — Jan 31 + 1 month is Mar 3 — and every later renewal
// would inherit that drift. The calendar is KST's whatever the server's time
// zone: a payment at 08:00 on Jan 31 in Seoul is still Jan 30 in UTC, and
// would otherwise renew on Feb 28 for the wrong reason, or on the 30th.
export function addMonths(from: Date, months: number): Date {
  const d = new Date(from.getTime() + KST_OFFSET_MS);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const lastDay = new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0),
  ).getUTCDate();
  d.setUTCDate(Math.min(day, lastDay));
  return new Date(d.getTime() - KST_OFFSET_MS);
}

export function addInterval(from: Date, interval: BillingInterval): Date {
  return addMonths(from, interval === "month" ? 1 : 12);
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
// 유니크 인덱스가 거절하면 withNewOrderId가 새 번호로 다시 넣는다. 결제가
// 잘못될 일도, 실패할 일도 없다.
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

// Inserts a payment row under a fresh order id, drawing another when the id is
// already taken (payments_order_id_key). Anything else is thrown as is, so
// callers still see their own attempt_key conflicts.
const ORDER_ID_TRIES = 3;

export async function withNewOrderId<T>(
  insert: (orderId: string) => Promise<T>,
): Promise<T> {
  for (let tries = 1; ; tries++) {
    try {
      return await insert(newOrderId());
    } catch (error) {
      if (tries >= ORDER_ID_TRIES || !isOrderIdConflict(error)) throw error;
    }
  }
}

function isOrderIdConflict(error: unknown): boolean {
  const { code, constraint } = (error ?? {}) as {
    code?: string;
    constraint?: string;
  };
  return code === "23505" && constraint === "payments_order_id_key";
}
