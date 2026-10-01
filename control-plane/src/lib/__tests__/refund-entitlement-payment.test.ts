import { describe, expect, test } from "@jest/globals";
import { supporterUntilFromLedger } from "@/lib/paid-time";

const YEAR_ONE_END = "2027-01-01T00:00:00Z";
const YEAR_TWO_END = "2028-01-01T00:00:00Z";

describe("supporter_until after a refund", () => {
  test("keeps the latest period while nothing is refunded", () => {
    expect(
      supporterUntilFromLedger([
        { periodEnd: YEAR_ONE_END, amount: 12000, refundedAmount: 0 },
        { periodEnd: YEAR_TWO_END, amount: 12000, refundedAmount: 0 },
      ]),
    ).toEqual(new Date(YEAR_TWO_END));
  });

  test("drops the time a refunded payment paid for", () => {
    expect(
      supporterUntilFromLedger([
        { periodEnd: YEAR_ONE_END, amount: 12000, refundedAmount: 0 },
        { periodEnd: YEAR_TWO_END, amount: 12000, refundedAmount: 12000 },
      ]),
    ).toEqual(new Date(YEAR_ONE_END));
  });

  test("clears the entitlement when every payment is refunded", () => {
    expect(
      supporterUntilFromLedger([
        { periodEnd: YEAR_ONE_END, amount: 12000, refundedAmount: 12000 },
      ]),
    ).toBeNull();
  });

  // 나루 does not offer partial refunds, so a partial amount is treated as
  // undoing the purchase rather than a slice of it.
  test("treats any refunded amount as undoing the purchase", () => {
    expect(
      supporterUntilFromLedger([
        { periodEnd: YEAR_TWO_END, amount: 12000, refundedAmount: 1 },
      ]),
    ).toBeNull();
  });

  // Refunding an earlier payment must not take back time a later, unrefunded
  // payment paid for.
  test("does not disturb periods other payments bought", () => {
    expect(
      supporterUntilFromLedger([
        { periodEnd: YEAR_ONE_END, amount: 12000, refundedAmount: 12000 },
        { periodEnd: YEAR_TWO_END, amount: 12000, refundedAmount: 0 },
      ]),
    ).toEqual(new Date(YEAR_TWO_END));
  });

  test("ignores payments that never granted a period", () => {
    expect(
      supporterUntilFromLedger([
        { periodEnd: null, amount: 12000, refundedAmount: 0 },
      ]),
    ).toBeNull();
  });

  // A one-time year bought during a paid month stacks after that month.
  // Refunding the month must pull the year forward to when it was paid for,
  // or the refunded month stays free.
  test("moves a stacked period up when the period ahead of it is refunded", () => {
    const month = {
      periodStart: "2026-01-01T00:00:00Z",
      periodEnd: "2026-02-01T00:00:00Z",
      paidAt: "2026-01-01T00:00:00Z",
      amount: 1000,
    };
    const year = {
      periodStart: "2026-02-01T00:00:00Z",
      periodEnd: "2027-02-01T00:00:00Z",
      paidAt: "2026-01-03T00:00:00Z",
      amount: 12000,
      refundedAmount: 0,
    };

    expect(
      supporterUntilFromLedger([{ ...month, refundedAmount: 0 }, year]),
    ).toEqual(new Date("2027-02-01T00:00:00Z"));
    expect(
      supporterUntilFromLedger([{ ...month, refundedAmount: 1000 }, year]),
    ).toEqual(new Date("2027-01-03T00:00:00Z"));
  });

  // Renewals are charged at or after their period starts, so a refund in the
  // middle of the chain leaves later renewals where they were.
  test("does not move renewals that were paid when their period began", () => {
    expect(
      supporterUntilFromLedger([
        {
          periodStart: "2026-01-01T00:00:00Z",
          periodEnd: "2026-02-01T00:00:00Z",
          paidAt: "2026-01-01T00:00:00Z",
          amount: 1000,
          refundedAmount: 0,
        },
        {
          periodStart: "2026-02-01T00:00:00Z",
          periodEnd: "2026-03-01T00:00:00Z",
          paidAt: "2026-02-01T04:00:00Z",
          amount: 1000,
          refundedAmount: 1000,
        },
        {
          periodStart: "2026-03-01T00:00:00Z",
          periodEnd: "2026-04-01T00:00:00Z",
          paidAt: "2026-03-01T04:00:00Z",
          amount: 1000,
          refundedAmount: 0,
        },
      ]),
    ).toEqual(new Date("2026-04-01T00:00:00Z"));
  });

  test("counts an over-refund as full", () => {
    expect(
      supporterUntilFromLedger([
        { periodEnd: YEAR_ONE_END, amount: 12000, refundedAmount: 13000 },
      ]),
    ).toBeNull();
  });
});
