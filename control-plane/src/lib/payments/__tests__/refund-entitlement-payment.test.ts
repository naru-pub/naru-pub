import { describe, expect, test } from "@jest/globals";
import { supporterUntilFromLedger } from "@/lib/payments/paid-time";

const YEAR_ONE_END = "2027-01-01T00:00:00Z";
const YEAR_TWO_END = "2028-01-01T00:00:00Z";

describe("supporter_until after a refund", () => {
  test("keeps the latest period while nothing is refunded", () => {
    expect(
      supporterUntilFromLedger([
        { periodEnd: YEAR_ONE_END, refundedAmount: 0 },
        { periodEnd: YEAR_TWO_END, refundedAmount: 0 },
      ]),
    ).toEqual(new Date(YEAR_TWO_END));
  });

  test("drops the time a refunded payment paid for", () => {
    expect(
      supporterUntilFromLedger([
        { periodEnd: YEAR_ONE_END, refundedAmount: 0 },
        { periodEnd: YEAR_TWO_END, refundedAmount: 12000 },
      ]),
    ).toEqual(new Date(YEAR_ONE_END));
  });

  test("clears the entitlement when every payment is refunded", () => {
    expect(
      supporterUntilFromLedger([
        { periodEnd: YEAR_ONE_END, refundedAmount: 12000 },
      ]),
    ).toBeNull();
  });

  // 나루 does not offer partial refunds, so a partial amount is treated as
  // undoing the purchase rather than a slice of it.
  test("treats any refunded amount as undoing the purchase", () => {
    expect(
      supporterUntilFromLedger([
        { periodEnd: YEAR_TWO_END, refundedAmount: 1 },
      ]),
    ).toBeNull();
  });

  // Refunding an earlier payment does not take back time a later, unrefunded
  // payment paid for — even one queued behind it: periods keep their dates.
  test("leaves later periods where they are", () => {
    expect(
      supporterUntilFromLedger([
        { periodEnd: YEAR_ONE_END, refundedAmount: 12000 },
        { periodEnd: YEAR_TWO_END, refundedAmount: 0 },
      ]),
    ).toEqual(new Date(YEAR_TWO_END));
  });

  test("ignores payments that never granted a period", () => {
    expect(
      supporterUntilFromLedger([{ periodEnd: null, refundedAmount: 0 }]),
    ).toBeNull();
  });
});
