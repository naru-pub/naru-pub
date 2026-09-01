import { describe, expect, test } from "@jest/globals";
import {
  canStartOneTimePurchase,
  canStartRecurringPurchase,
  scheduledRecurringStart,
} from "@/lib/support-purchases";

const now = new Date("2026-09-01T00:00:00Z");

describe("support payment-mode switches", () => {
  test("allows either mode without an active paid period", () => {
    expect(
      canStartRecurringPurchase({
        supporterComp: false,
        supporterUntil: null,
        subscriptionStatus: null,
        now,
      }),
    ).toBe(true);
    expect(
      canStartOneTimePurchase({
        supporterComp: false,
        supporterUntil: null,
        subscriptionStatus: null,
        now,
      }),
    ).toBe(true);
  });

  test("allows switching an active recurring subscription to one-time", () => {
    expect(
      canStartOneTimePurchase({
        supporterComp: false,
        supporterUntil: "2027-09-01T00:00:00Z",
        subscriptionStatus: "active",
        now,
      }),
    ).toBe(true);
    expect(
      canStartRecurringPurchase({
        supporterComp: false,
        supporterUntil: "2027-09-01T00:00:00Z",
        subscriptionStatus: "active",
        now,
      }),
    ).toBe(false);
    expect(
      canStartOneTimePurchase({
        supporterComp: false,
        supporterUntil: "2027-09-01T00:00:00Z",
        subscriptionStatus: "canceled",
        now,
      }),
    ).toBe(true);
  });

  test("allows scheduling recurring after one-time support", () => {
    expect(
      canStartRecurringPurchase({
        supporterComp: false,
        supporterUntil: "2027-09-01T00:00:00Z",
        subscriptionStatus: null,
        now,
      }),
    ).toBe(true);
    expect(
      canStartOneTimePurchase({
        supporterComp: false,
        supporterUntil: "2027-09-01T00:00:00Z",
        subscriptionStatus: null,
        now,
      }),
    ).toBe(false);
    expect(
      canStartOneTimePurchase({
        supporterComp: false,
        supporterUntil: "2027-09-01T00:00:00Z",
        subscriptionStatus: "scheduled",
        now,
      }),
    ).toBe(false);
  });

  test("blocks comp users and duplicate scheduled subscriptions", () => {
    for (const check of [canStartRecurringPurchase, canStartOneTimePurchase]) {
      expect(
        check({
          supporterComp: true,
          supporterUntil: null,
          subscriptionStatus: null,
          now,
        }),
      ).toBe(false);
    }
    expect(
      canStartRecurringPurchase({
        supporterComp: false,
        supporterUntil: "2027-09-01T00:00:00Z",
        subscriptionStatus: "scheduled",
        now,
      }),
    ).toBe(false);
  });

  test("schedules the first recurring charge at prepaid expiry", () => {
    expect(
      scheduledRecurringStart("2027-09-01T00:00:00Z", now)?.toISOString(),
    ).toBe("2027-09-01T00:00:00.000Z");
    expect(scheduledRecurringStart("2026-08-31T23:59:59Z", now)).toBeNull();
  });
});
