import {
  afterEach,
  beforeEach,
  describe,
  expect,
  jest,
  test,
} from "@jest/globals";
import {
  chargeBillingKey,
  confirmPayment,
  isDefinitiveTossFailure,
  isOneTimeYears,
  isPurchasableOneTimeYears,
  newOrderId,
  oneTimeAmount,
  oneTimeOrderName,
  oneTimeYearsForAmount,
  TossApiError,
} from "@/lib/toss";

describe("Toss payment requests", () => {
  const originalSecret = process.env.TOSS_SECRET_KEY;

  beforeEach(() => {
    process.env.TOSS_SECRET_KEY = "test_secret";
    global.fetch = jest.fn<typeof fetch>().mockResolvedValue({
      ok: true,
      json: async () => ({
        paymentKey: "payment",
        orderId: "order",
        status: "DONE",
        totalAmount: 1000,
      }),
    } as Response);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    if (originalSecret === undefined) delete process.env.TOSS_SECRET_KEY;
    else process.env.TOSS_SECRET_KEY = originalSecret;
  });

  test("billing retries carry the stable order id as an idempotency key", async () => {
    await chargeBillingKey({
      billingKey: "billing",
      customerKey: "customer",
      amount: 1000,
      orderId: "order",
      orderName: "monthly",
      idempotencyKey: "order",
    });

    expect(fetch).toHaveBeenCalledWith(
      "https://api.tosspayments.com/v1/billing/billing",
      expect.objectContaining({
        headers: expect.objectContaining({ "Idempotency-Key": "order" }),
      }),
    );
  });

  test("one-time confirmation retries use the same idempotency key", async () => {
    await confirmPayment(
      { paymentKey: "payment", orderId: "order", amount: 12000 },
      "order",
    );

    expect(fetch).toHaveBeenCalledWith(
      "https://api.tosspayments.com/v1/payments/confirm",
      expect.objectContaining({
        headers: expect.objectContaining({ "Idempotency-Key": "order" }),
      }),
    );
  });

  test("validates and prices multi-year one-time support", () => {
    expect(isOneTimeYears(1)).toBe(true);
    expect(isOneTimeYears(10)).toBe(true);
    expect(isOneTimeYears(0)).toBe(false);
    expect(isOneTimeYears(1.5)).toBe(false);
    expect(isOneTimeYears(11)).toBe(false);
    expect(oneTimeAmount(3)).toBe(36000);
    expect(oneTimeYearsForAmount(60000)).toBe(5);
    expect(oneTimeYearsForAmount(13000)).toBeNull();
    expect(oneTimeOrderName(2)).toBe("나루 후원 (2년, 한 번만 결제)");
    // Only one year may still be sold, but older multi-year amounts must keep
    // resolving so their confirmations and refunds reconcile.
    expect(isPurchasableOneTimeYears(1)).toBe(true);
    expect(isPurchasableOneTimeYears(2)).toBe(false);
    expect(isPurchasableOneTimeYears(0)).toBe(false);
  });

  test.each([
    [400, true],
    [402, true],
    [409, false],
    [500, false],
  ])("classifies HTTP %i payment failures", (status, definitive) => {
    expect(isDefinitiveTossFailure(new TossApiError("failure", status))).toBe(
      definitive,
    );
  });

  test("treats transport failures as ambiguous", () => {
    expect(isDefinitiveTossFailure(new TypeError("network failure"))).toBe(
      false,
    );
  });
});

// Toss rejects an orderId outside 6–64 characters of [A-Za-z0-9-_], and reuses
// are refused for the life of the merchant account. On top of that the id has
// to survive being read out over the phone, which is what digits-only and the
// grouping are for.
describe("order ids", () => {
  test("stays inside the character set and length Toss accepts", () => {
    for (let i = 0; i < 100; i++) {
      expect(newOrderId()).toMatch(/^[A-Za-z0-9_-]{6,64}$/);
    }
  });

  // 전화로 불러 줄 번호라 철자를 되물을 글자가 하나도 없어야 한다.
  test("is a date and digits, with nothing to spell out", () => {
    for (let i = 0; i < 100; i++) {
      expect(newOrderId()).toMatch(/^\d{4}-\d{2}-\d{2}-\d{4}-\d{4}$/);
    }
  });

  // 날짜를 날짜로 읽을 수 있어야 전화로 한 번 더 맞춰볼 수 있다. KST 기준이라
  // UTC로 찍으면 하루가 어긋난다.
  test("opens with the KST date of the payment", () => {
    // 2026-09-04 00:30 KST — the UTC day before, so a UTC prefix would differ.
    expect(newOrderId(new Date("2026-09-03T15:30:00Z"))).toMatch(
      /^2026-09-04-/,
    );
    expect(newOrderId(new Date("2026-09-03T14:30:00Z"))).toMatch(
      /^2026-09-03-/,
    );
  });

  test("keeps a leading zero rather than shortening the id", () => {
    const ids = Array.from({ length: 2000 }, () => newOrderId());
    expect(ids.every((id) => id.length === 20)).toBe(true);
  });

  test("does not repeat", () => {
    const ids = new Set(Array.from({ length: 1000 }, () => newOrderId()));
    expect(ids.size).toBe(1000);
  });
});
