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
