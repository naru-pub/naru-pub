import {
  getPaymentByOrderId,
  isDefinitiveTossFailure,
  TossApiError,
  TossPaymentFlow,
  TossPaymentResult,
} from "@/lib/toss";

// Kept apart from lib/toss so it reaches Toss through that module's exports,
// the same seam the payment tests mock.

export type SettledOrder =
  | { state: "paid"; payment: TossPaymentResult }
  | { state: "refused"; payment: TossPaymentResult | null }
  | { state: "unknown"; tossStatus: string | null };

// What became of an order whose charge or confirm call failed. Toss's docs
// say to look the payment up before treating a failed call as a failed
// payment: an error can come back for an order that was approved, and a row
// marked failed is never looked at again. Only Toss's own verdict on the order
// (ABORTED, EXPIRED), or a refusal on the merits for an order Toss never
// recorded, counts as refused. Never throws.
export async function settleFailedOrder(opts: {
  orderId: string;
  amount: number;
  flow: TossPaymentFlow;
  error: unknown;
}): Promise<SettledOrder> {
  let payment: TossPaymentResult;
  try {
    payment = await getPaymentByOrderId(opts.orderId, opts.flow);
  } catch (lookupError) {
    if (
      lookupError instanceof TossApiError &&
      lookupError.status === 404 &&
      isDefinitiveTossFailure(opts.error)
    ) {
      return { state: "refused", payment: null };
    }
    return { state: "unknown", tossStatus: null };
  }
  if (payment.orderId !== opts.orderId || payment.totalAmount !== opts.amount) {
    return { state: "unknown", tossStatus: payment.status ?? null };
  }
  if (payment.status === "DONE") return { state: "paid", payment };
  if (payment.status === "ABORTED" || payment.status === "EXPIRED") {
    return { state: "refused", payment };
  }
  return { state: "unknown", tossStatus: payment.status ?? null };
}
