import { describe, expect, test } from "@jest/globals";
import { canStartSupportPurchase } from "@/lib/support-purchases";

const now = new Date("2026-09-01T00:00:00Z");

describe("support purchase eligibility", () => {
  test("allows a new choice without an active paid period", () => {
    expect(
      canStartSupportPurchase({
        supporterComp: false,
        supporterUntil: null,
        hasActiveSubscription: false,
        now,
      }),
    ).toBe(true);
  });

  test("blocks purchases during recurring, one-time, and comp support", () => {
    expect(
      canStartSupportPurchase({
        supporterComp: false,
        supporterUntil: null,
        hasActiveSubscription: true,
        now,
      }),
    ).toBe(false);
    expect(
      canStartSupportPurchase({
        supporterComp: false,
        supporterUntil: "2027-09-01T00:00:00Z",
        hasActiveSubscription: false,
        now,
      }),
    ).toBe(false);
    expect(
      canStartSupportPurchase({
        supporterComp: true,
        supporterUntil: null,
        hasActiveSubscription: false,
        now,
      }),
    ).toBe(false);
  });

  test("allows a new choice when the paid period has expired", () => {
    expect(
      canStartSupportPurchase({
        supporterComp: false,
        supporterUntil: "2026-08-31T23:59:59Z",
        hasActiveSubscription: false,
        now,
      }),
    ).toBe(true);
  });
});
