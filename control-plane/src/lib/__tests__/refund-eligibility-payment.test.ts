import { describe, expect, test } from "@jest/globals";
import {
  refundEligibility,
  refundDeadline,
  REFUND_BLOCKING_FEATURES,
  REFUND_WINDOW_DAYS,
} from "@/lib/refunds";

const PAID_AT = new Date("2026-09-01T00:00:00Z");
const day = (n: number) =>
  new Date(PAID_AT.getTime() + n * 24 * 60 * 60 * 1000);

const paid = (overrides: Partial<Parameters<typeof refundEligibility>[0]>) => ({
  status: "done",
  paidAt: PAID_AT,
  refundedAmount: 0,
  featureUses: [],
  ...overrides,
});

describe("self-serve refund eligibility", () => {
  test("allows an unused payment inside the window", () => {
    expect(refundEligibility(paid({ now: day(6) }))).toEqual({
      eligible: true,
      deadline: refundDeadline(PAID_AT),
    });
  });

  test("allows it on the last day of the window", () => {
    const result = refundEligibility(
      paid({ now: new Date(refundDeadline(PAID_AT).getTime() - 1000) }),
    );
    expect(result.eligible).toBe(true);
  });

  test("refuses once the window has passed", () => {
    const result = refundEligibility(
      paid({ now: day(REFUND_WINDOW_DAYS + 0.1) }),
    );
    expect(result).toMatchObject({ eligible: false, reason: "window_passed" });
  });

  // 사용하지 않으셨다면 — a supporter feature touched after paying consumes
  // what the payment bought.
  test("refuses when a supporter feature was used after paying", () => {
    const result = refundEligibility(
      paid({
        now: day(2),
        featureUses: [{ feature: "custom_domains", lastUsedAt: day(1) }],
      }),
    );
    expect(result).toMatchObject({
      eligible: false,
      reason: "feature_used",
      usedFeatures: ["custom_domains"],
    });
  });

  // 방문자 현황은 열어보는 것이 전부라, 후원이 값어치를 하는지 확인한 것만으로
  // 환불을 잃지 않는다.
  test("still refunds after viewing 방문자 현황", () => {
    const result = refundEligibility(
      paid({
        now: day(2),
        featureUses: [{ feature: "analytics", lastUsedAt: day(1) }],
      }),
    );
    expect(result.eligible).toBe(true);
  });

  // Usage from a previous, expired period says nothing about this payment.
  test("ignores feature use from before the payment", () => {
    const result = refundEligibility(
      paid({
        now: day(2),
        featureUses: [{ feature: "database", lastUsedAt: day(-30) }],
      }),
    );
    expect(result.eligible).toBe(true);
  });

  test("refuses a payment that was already refunded", () => {
    const result = refundEligibility(
      paid({ now: day(1), refundedAmount: 12000 }),
    );
    expect(result).toMatchObject({
      eligible: false,
      reason: "already_refunded",
    });
  });

  test("refuses a payment that never completed", () => {
    expect(
      refundEligibility(paid({ now: day(1), status: "pending", paidAt: null })),
    ).toMatchObject({ eligible: false, reason: "not_paid" });
  });

  test("names every refund-blocking feature used since the payment", () => {
    const result = refundEligibility(
      paid({
        now: day(3),
        featureUses: [
          { feature: "custom_domains", lastUsedAt: day(2) },
          { feature: "github_deploys", lastUsedAt: day(-1) },
          { feature: "analytics", lastUsedAt: day(2) },
          { feature: "database", lastUsedAt: day(1) },
        ],
      }),
    );
    expect(result).toMatchObject({
      eligible: false,
      usedFeatures: ["custom_domains", "database"],
    });
  });

  test("blocks on what the payment actually handed over", () => {
    expect(REFUND_BLOCKING_FEATURES).toEqual([
      "custom_domains",
      "github_deploys",
      "database",
    ]);
  });
});
