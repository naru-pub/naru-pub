import { describe, expect, test } from "@jest/globals";
import { supporterUntilFromLedger } from "@/lib/payment-reconciliation";

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

  test("drops the time a fully refunded payment paid for", () => {
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

  test("leaves partial refunds alone", () => {
    expect(
      supporterUntilFromLedger([
        { periodEnd: YEAR_TWO_END, amount: 12000, refundedAmount: 11999 },
      ]),
    ).toEqual(new Date(YEAR_TWO_END));
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

  test("counts an over-refund as full", () => {
    expect(
      supporterUntilFromLedger([
        { periodEnd: YEAR_ONE_END, amount: 12000, refundedAmount: 13000 },
      ]),
    ).toBeNull();
  });
});
