import { describe, expect, test } from "@jest/globals";
import { refundDetails } from "@/lib/payment-reconciliation";
import type { TossPaymentResult } from "@/lib/toss";

function payment(
  status: string,
  cancels: TossPaymentResult["cancels"],
): TossPaymentResult {
  return {
    paymentKey: "payment",
    orderId: "order",
    status,
    totalAmount: 12000,
    cancels,
  };
}

describe("lenient refund reconciliation", () => {
  test("sums partial refunds and keeps the latest cancellation time", () => {
    const details = refundDetails(
      payment("PARTIAL_CANCELED", [
        { cancelAmount: 2000, canceledAt: "2026-08-01T10:00:00+09:00" },
        { cancelAmount: 3000, canceledAt: "2026-08-02T10:00:00+09:00" },
      ]),
      12000,
    );

    expect(details.refundedAmount).toBe(5000);
    expect(details.full).toBe(false);
    expect(details.refundedAt?.toISOString()).toBe("2026-08-02T01:00:00.000Z");
  });

  test("recognizes a full refund from accumulated cancellation amounts", () => {
    expect(
      refundDetails(payment("CANCELED", [{ cancelAmount: 12000 }]), 12000).full,
    ).toBe(true);
    expect(
      refundDetails(
        payment("PARTIAL_CANCELED", [
          { cancelAmount: 5000 },
          { cancelAmount: 7000 },
        ]),
        12000,
      ).full,
    ).toBe(true);
  });

  test("does not treat an unapproved canceled order as a refund", () => {
    expect(refundDetails(payment("CANCELED", null), 12000)).toMatchObject({
      refundedAmount: 0,
      full: false,
    });
  });
});
