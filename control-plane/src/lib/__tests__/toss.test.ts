import {
  afterEach,
  beforeEach,
  describe,
  expect,
  jest,
  test,
} from "@jest/globals";
import {
  addInterval,
  cancelPayment,
  chargeBillingKey,
  confirmPayment,
  deleteBillingKey,
  isDefinitiveTossFailure,
  issueBillingKey,
  isOneTimeYears,
  isTossTestMode,
  withTossLab,
  isPurchasableOneTimeYears,
  newOrderId,
  oneTimeAmount,
  oneTimeOrderName,
  oneTimeYearsForAmount,
  TossApiError,
} from "@/lib/toss";

describe("Toss payment requests", () => {
  const originalBillingSecret = process.env.TOSS_BILLING_SECRET_KEY;
  const originalPaymentSecret = process.env.TOSS_PAYMENT_SECRET_KEY;

  beforeEach(() => {
    process.env.TOSS_BILLING_SECRET_KEY = "test_billing_secret";
    process.env.TOSS_PAYMENT_SECRET_KEY = "test_payment_secret";
    global.fetch = jest.fn<typeof fetch>().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          paymentKey: "payment",
          orderId: "order",
          status: "DONE",
          totalAmount: 1000,
        }),
    } as Response);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    if (originalBillingSecret === undefined) {
      delete process.env.TOSS_BILLING_SECRET_KEY;
    } else {
      process.env.TOSS_BILLING_SECRET_KEY = originalBillingSecret;
    }
    if (originalPaymentSecret === undefined) {
      delete process.env.TOSS_PAYMENT_SECRET_KEY;
    } else {
      process.env.TOSS_PAYMENT_SECRET_KEY = originalPaymentSecret;
    }
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
    expect(fetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization:
            "Basic " + Buffer.from("test_billing_secret:").toString("base64"),
        }),
      }),
    );
  });

  // An authKey works once. A retry after a lost response must replay the key
  // Toss already issued rather than be refused for reusing the authKey.
  test("billing key issuance is idempotent per authKey", async () => {
    const authKey = "a".repeat(300);
    await issueBillingKey(authKey, "customer");
    await issueBillingKey(authKey, "customer");
    await issueBillingKey("another-auth-key", "customer");

    const keys = jest
      .mocked(fetch)
      .mock.calls.map(
        ([, init]) =>
          (init?.headers as Record<string, string>)["Idempotency-Key"],
      );
    expect(keys[0]).toBe(keys[1]);
    expect(keys[2]).not.toBe(keys[0]);
    // Toss caps idempotency keys at 300 characters.
    expect(keys[0].length).toBeLessThanOrEqual(300);
    expect(keys[0]).not.toContain(authKey);
  });

  // The billing lab charges and refunds for real; it may only exist where no
  // key can move real money.
  test("test mode means every configured key is a test key", () => {
    expect(isTossTestMode()).toBe(true);
    process.env.TOSS_PAYMENT_SECRET_KEY = "live_sk_payment";
    expect(isTossTestMode()).toBe(false);
    delete process.env.TOSS_PAYMENT_SECRET_KEY;
    expect(isTossTestMode()).toBe(true);
    delete process.env.TOSS_BILLING_SECRET_KEY;
    expect(isTossTestMode()).toBe(false);
  });

  test("the lab records calls with billing keys masked", async () => {
    jest.mocked(fetch).mockResolvedValue({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({ billingKey: "billing-key-secret", status: "DONE" }),
    } as Response);

    const { calls } = await withTossLab(
      { testCode: "REJECT_CARD_PAYMENT" },
      () =>
        chargeBillingKey({
          billingKey: "billing-key-secret",
          customerKey: "customer",
          amount: 1000,
          orderId: "order",
          orderName: "monthly",
          idempotencyKey: "order",
        }),
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      method: "POST",
      path: "/v1/billing/bill••••cret",
      testCode: "REJECT_CARD_PAYMENT",
      status: 200,
      responseBody: { billingKey: "bill••••cret", status: "DONE" },
    });
    expect(JSON.stringify(calls)).not.toContain("billing-key-secret");
    expect(fetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({
          "TossPayments-Test-Code": "REJECT_CARD_PAYMENT",
        }),
      }),
    );
  });

  test("the test code is never sent with a live key, nor outside the lab", async () => {
    process.env.TOSS_BILLING_SECRET_KEY = "live_sk_billing";
    await withTossLab({ testCode: "REJECT_CARD_PAYMENT" }, () =>
      deleteBillingKey("key"),
    );
    process.env.TOSS_BILLING_SECRET_KEY = "test_billing_secret";
    await deleteBillingKey("key");

    for (const [, init] of jest.mocked(fetch).mock.calls) {
      expect(init?.headers).not.toHaveProperty("TossPayments-Test-Code");
    }
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
    expect(fetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization:
            "Basic " + Buffer.from("test_payment_secret:").toString("base64"),
        }),
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
    expect(oneTimeOrderName(2)).toBe("나루 결제 (2년, 한 번만 결제)");
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

  // A gateway error page is a response, not the caller's bad input. It has to
  // surface as a TossApiError that stays ambiguous for a 5xx.
  test("reports a non-JSON error page as an ambiguous Toss failure", async () => {
    global.fetch = jest.fn<typeof fetch>().mockResolvedValue({
      ok: false,
      status: 502,
      text: async () => "<html>Bad Gateway</html>",
    } as unknown as Response);

    const error = await confirmPayment(
      { paymentKey: "payment", orderId: "order", amount: 12000 },
      "order",
    ).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(TossApiError);
    expect((error as TossApiError).status).toBe(502);
    expect(isDefinitiveTossFailure(error)).toBe(false);
  });

  // Toss replays the first response for an idempotency key — errors included
  // — for 15 days, so a fixed key would lock a failed refund out of retries.
  test("cancels without an idempotency key, on the payment's own MID", async () => {
    await cancelPayment({
      flow: "billing",
      paymentKey: "pay/key",
      cancelReason: "refund",
    });

    const [url, init] = (fetch as jest.Mock<typeof fetch>).mock.calls[0];
    expect(url).toBe(
      "https://api.tosspayments.com/v1/payments/pay%2Fkey/cancel",
    );
    expect(init?.headers).not.toHaveProperty("Idempotency-Key");
    expect(init?.headers).toHaveProperty(
      "Authorization",
      "Basic " + Buffer.from("test_billing_secret:").toString("base64"),
    );
  });

  test("deletes a billing key, accepting an empty response body", async () => {
    global.fetch = jest.fn<typeof fetch>().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => "",
    } as Response);

    await deleteBillingKey("billing-key");

    expect(fetch).toHaveBeenCalledWith(
      "https://api.tosspayments.com/v1/billing/billing-key",
      expect.objectContaining({
        method: "DELETE",
        headers: expect.objectContaining({
          Authorization:
            "Basic " + Buffer.from("test_billing_secret:").toString("base64"),
        }),
      }),
    );
  });

  test("reports a Toss error body with its code", async () => {
    global.fetch = jest.fn<typeof fetch>().mockResolvedValue({
      ok: false,
      status: 404,
      text: async () =>
        JSON.stringify({ code: "NOT_FOUND_BILLING", message: "없음" }),
    } as Response);

    const error = await deleteBillingKey("gone").catch((e: unknown) => e);

    expect(error).toBeInstanceOf(TossApiError);
    expect(error).toMatchObject({ status: 404, code: "NOT_FOUND_BILLING" });
  });
});

describe("billing periods", () => {
  test.each([
    ["2026-01-15T00:00:00+09:00", "month", "2026-02-15T00:00:00+09:00"],
    ["2026-01-31T00:00:00+09:00", "month", "2026-02-28T00:00:00+09:00"],
    ["2028-01-31T00:00:00+09:00", "month", "2028-02-29T00:00:00+09:00"],
    ["2026-03-31T00:00:00+09:00", "month", "2026-04-30T00:00:00+09:00"],
    ["2026-12-31T00:00:00+09:00", "month", "2027-01-31T00:00:00+09:00"],
    ["2028-02-29T00:00:00+09:00", "year", "2029-02-28T00:00:00+09:00"],
    ["2026-06-10T00:00:00+09:00", "year", "2027-06-10T00:00:00+09:00"],
    // Still Jan 30 in UTC, but Jan 31 where the supporter paid.
    ["2026-01-31T08:00:00+09:00", "month", "2026-02-28T08:00:00+09:00"],
    // Still Mar 31 in UTC, but already Apr 1 in Seoul.
    ["2026-04-01T02:00:00+09:00", "month", "2026-05-01T02:00:00+09:00"],
  ] as const)(
    "%s plus one %s ends %s without spilling into the next month",
    (from, interval, expected) => {
      expect(addInterval(new Date(from), interval)).toEqual(new Date(expected));
    },
  );
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

describe("record ids from requests", () => {
  const { parseUuid } =
    jest.requireActual<typeof import("@/lib/uuid")>("@/lib/uuid");

  test("accepts a UUID, lower-cased", () => {
    expect(parseUuid("019C175B-89E8-7000-85FF-5F03F7B0ABD4")).toBe(
      "019c175b-89e8-7000-85ff-5f03f7b0abd4",
    );
  });

  test.each([
    undefined,
    null,
    42,
    "42",
    "",
    "not-a-uuid",
    "019c175b89e8700085ff5f03f7b0abd4",
  ])("refuses %p", (value) => {
    expect(parseUuid(value)).toBeNull();
  });
});
