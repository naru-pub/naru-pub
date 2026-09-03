import { describe, expect, test } from "@jest/globals";
import {
  refundEligibility,
  refundDeadline,
  REFUND_WINDOW_DAYS,
} from "@/lib/refunds";

const PAID_AT = new Date("2026-09-01T00:00:00Z");
const day = (n: number) =>
  new Date(PAID_AT.getTime() + n * 24 * 60 * 60 * 1000);

const paid = (overrides: Partial<Parameters<typeof refundEligibility>[0]>) => ({
  status: "done",
  paidAt: PAID_AT,
  refundedAmount: 0,
  ...overrides,
});

describe("self-serve refund eligibility", () => {
  test("allows a refund inside the window", () => {
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

  // 이유를 묻지 않는다는 것은 판정이 결제일 하나만 본다는 뜻이다. 사용 기록도,
  // 후원 종류도, 금액도 묻지 않는다. 조건이 하나뿐이라는 것 자체가 약속이라,
  // 입력이 늘어나면 이 테스트가 먼저 깨진다.
  test("asks nothing but the date, the amount refunded and the status", () => {
    expect(Object.keys(paid({ now: day(3) })).sort()).toEqual([
      "now",
      "paidAt",
      "refundedAmount",
      "status",
    ]);
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
});
