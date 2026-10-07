import "@/lib/payments/toss-calls";
import { randomUUID } from "crypto";
import {
  cancelPayment,
  chargeBillingKey,
  confirmPayment,
  deleteBillingKey,
  getPaymentByOrderId,
  isDefinitiveTossFailure,
  issueBillingKey,
  TossApiError,
  type TossPaymentFlow,
  type TossPaymentResult,
} from "@/lib/payments/toss";

// The payment code's one way to Toss for anything that moves money. Each
// operation answers with what became of it — approved, declined, or not
// known yet — instead of throwing, so the rules for reading Toss's errors
// live here once: a failed call is not a failed payment until the order says
// so, a 4xx is not always a verdict on the card, and a lookup that finds
// nothing means nothing was charged only when Toss refused on the merits.
//
// It reaches Toss through lib/payments/toss's exports, the seam the payment tests mock,
// and every call is kept in toss_calls (lib/payments/toss-calls).

export type OrderOutcome =
  | { kind: "approved"; payment: TossPaymentResult }
  // Toss ended the order without approving it: a declined card, an order it
  // aborted or expired. `payment` is Toss's record of it, when there is one.
  | { kind: "declined"; error: unknown; payment: TossPaymentResult | null }
  // Not known yet. `sent` says whether a charge or confirm for the order has
  // ever reached Toss — one that never did cannot have charged anything.
  | {
      kind: "unknown";
      error: unknown;
      tossStatus: string | null;
      sent: boolean;
    };

export type LookupOutcome =
  | { kind: "found"; payment: TossPaymentResult }
  | { kind: "not_found" }
  | { kind: "unknown"; error: unknown };

export async function lookupOrder(
  orderId: string,
  flow: TossPaymentFlow,
  opts: { timeoutMs?: number } = {},
): Promise<LookupOutcome> {
  try {
    return {
      kind: "found",
      payment: await (opts.timeoutMs
        ? getPaymentByOrderId(orderId, flow, opts)
        : getPaymentByOrderId(orderId, flow)),
    };
  } catch (error) {
    // Only Toss saying it has no such payment. Other 404s — NOT_FOUND_MERCHANT
    // when the secret key is not the MID's, say — tell nothing about the
    // order, and reading them as "never paid" would expire an approved one.
    if (error instanceof TossApiError && error.code === "NOT_FOUND_PAYMENT") {
      return { kind: "not_found" };
    }
    return { kind: "unknown", error };
  }
}

const ENDED_UNPAID = new Set(["ABORTED", "EXPIRED"]);

// What became of an order whose charge or confirm call failed. Toss's docs say
// to look the payment up before treating a failed call as a failed payment:
// an error can come back for an order that was approved, and a row marked
// failed is never looked at again. Only Toss's own verdict on the order
// (ABORTED, EXPIRED), or a refusal on the merits for an order Toss never
// recorded, counts as declined.
export async function settleOrder(opts: {
  orderId: string;
  amount: number;
  flow: TossPaymentFlow;
  error: unknown;
}): Promise<OrderOutcome> {
  const found = await lookupOrder(opts.orderId, opts.flow);
  if (found.kind === "not_found") {
    return isDefinitiveTossFailure(opts.error)
      ? { kind: "declined", error: opts.error, payment: null }
      : { kind: "unknown", error: opts.error, tossStatus: null, sent: true };
  }
  if (found.kind === "unknown") {
    return { kind: "unknown", error: opts.error, tossStatus: null, sent: true };
  }
  return readOrder(found.payment, opts, opts.error);
}

// Toss's record of an order, read as an outcome. A record that does not
// match the order (another order id or amount) says nothing about it.
function readOrder(
  payment: TossPaymentResult,
  order: { orderId: string; amount: number },
  error: unknown,
): OrderOutcome {
  if (
    payment.orderId !== order.orderId ||
    payment.totalAmount !== order.amount
  ) {
    return {
      kind: "unknown",
      error,
      tossStatus: payment.status ?? null,
      sent: true,
    };
  }
  if (payment.status === "DONE") return { kind: "approved", payment };
  if (ENDED_UNPAID.has(payment.status)) {
    return { kind: "declined", error, payment };
  }
  return {
    kind: "unknown",
    error,
    tossStatus: payment.status ?? null,
    sent: true,
  };
}

// Charges a billing key for one order, safely repeatable: the order is looked
// up first (an approved or ended order is not charged again), then charged
// under its own id as idempotency key, and a failed call is settled by the
// order's own outcome. `beforeSend` runs just before the charge goes out —
// the caller records the attempt there (payments.charge_attempted_at).
export async function chargeOrder(opts: {
  billingKey: string;
  customerKey: string;
  amount: number;
  orderId: string;
  orderName: string;
  customerName: string;
  // A charge for this order went out on an earlier try.
  sentBefore: boolean;
  beforeSend: () => Promise<void>;
}): Promise<OrderOutcome> {
  const order = { orderId: opts.orderId, amount: opts.amount };
  const existing = await lookupOrder(opts.orderId, "billing");
  if (existing.kind === "unknown") {
    return {
      kind: "unknown",
      error: existing.error,
      tossStatus: null,
      sent: opts.sentBefore,
    };
  }
  if (existing.kind === "found") {
    const read = readOrder(existing.payment, order, null);
    // Toss knows the order: settled one way or the other, or still working
    // on it — either way not charged again.
    if (read.kind !== "unknown" || existing.payment.status !== "READY") {
      return read.kind === "declined"
        ? {
            ...read,
            error: new TossApiError(
              `order ${opts.orderId} was ${existing.payment.status}`,
              400,
              existing.payment.status,
            ),
          }
        : read;
    }
  }

  await opts.beforeSend();
  let payment: TossPaymentResult;
  try {
    payment = await chargeBillingKey({
      billingKey: opts.billingKey,
      customerKey: opts.customerKey,
      amount: opts.amount,
      orderId: opts.orderId,
      orderName: opts.orderName,
      customerName: opts.customerName,
      idempotencyKey: opts.orderId,
    });
  } catch (error) {
    return settleOrder({ ...order, flow: "billing", error });
  }
  return readOrder(
    payment,
    order,
    new Error(`unexpected payment status: ${payment.status}`),
  );
}

// Approves a one-time payment the buyer authenticated, for the amount 나루
// recorded (never the one the browser reports). `firstKey` is the idempotency
// key of the first attempt (the order id, for the callback). With
// `retryOnce`, a call that failed ambiguously while Toss still shows the
// payment authenticated but unapproved is sent once more under a fresh key:
// the first key would only replay the failure while Toss's 10 minutes run
// out, and Toss refuses to approve a payment twice. A 409 means the first
// confirm is still running, so it is not repeated.
export async function confirmOrder(opts: {
  paymentKey: string;
  orderId: string;
  amount: number;
  firstKey: string;
  retryOnce: boolean;
  beforeSend: () => Promise<void>;
}): Promise<OrderOutcome> {
  const params = {
    paymentKey: opts.paymentKey,
    orderId: opts.orderId,
    amount: opts.amount,
  };
  const order = { orderId: opts.orderId, amount: opts.amount };
  const attempt = async (key: string): Promise<OrderOutcome> => {
    await opts.beforeSend();
    try {
      return readOrder(
        await confirmPayment(params, key),
        order,
        new Error("confirm returned an unexpected status"),
      );
    } catch (error) {
      return settleOrder({ ...order, flow: "one-time", error });
    }
  };

  const first = await attempt(opts.firstKey);
  if (
    opts.retryOnce &&
    first.kind === "unknown" &&
    first.tossStatus === "IN_PROGRESS" &&
    !isDefinitiveTossFailure(first.error) &&
    !(first.error instanceof TossApiError && first.error.status === 409)
  ) {
    return attempt(`${opts.orderId}:${randomUUID()}`);
  }
  return first;
}

export type IssueOutcome =
  | {
      kind: "issued";
      billingKey: string;
      mid: string | null;
      cardCompany: string | null;
      cardNumber: string | null;
    }
  // The authKey was refused on its merits (expired, used, card refused): the
  // supporter starts over.
  | { kind: "refused"; error: TossApiError }
  // Anything else may have issued a key, which the same authKey's idempotency
  // key hands back when asked again.
  | { kind: "unknown"; error: unknown };

export async function issueKey(
  authKey: string,
  customerKey: string,
): Promise<IssueOutcome> {
  try {
    const issued = await issueBillingKey(authKey, customerKey);
    return {
      kind: "issued",
      billingKey: issued.billingKey,
      mid: issued.mId ?? null,
      cardCompany: issued.card?.issuerCode ?? issued.cardCompany ?? null,
      cardNumber: issued.card?.number ?? issued.cardNumber ?? null,
    };
  } catch (error) {
    return isDefinitiveTossFailure(error)
      ? { kind: "refused", error }
      : { kind: "unknown", error };
  }
}

export type CancelOutcome =
  | { kind: "canceled"; payment: TossPaymentResult }
  // Toss answered and did not cancel (a 4xx — NOT_CANCELABLE_PAYMENT, or a
  // temporary PROVIDER_ERROR): nothing was refunded; asking again is fine.
  | { kind: "refused"; error: TossApiError }
  // A 5xx or no answer: it may have canceled all the same.
  | { kind: "unknown"; error: unknown };

export async function cancelOrder(opts: {
  flow: TossPaymentFlow;
  paymentKey: string;
  cancelReason: string;
}): Promise<CancelOutcome> {
  try {
    return { kind: "canceled", payment: await cancelPayment(opts) };
  } catch (error) {
    return error instanceof TossApiError && error.status < 500
      ? { kind: "refused", error }
      : { kind: "unknown", error };
  }
}

export type DeleteKeyOutcome =
  | { kind: "deleted" }
  | { kind: "failed"; error: unknown };

// Deletes a billing key at Toss. A key Toss no longer has (NOT_FOUND_BILLING)
// is as deleted as it will ever be; any other 404 — a MID Toss does not know —
// says nothing about the key, which may still be chargeable.
export async function deleteKey(billingKey: string): Promise<DeleteKeyOutcome> {
  try {
    await deleteBillingKey(billingKey);
    return { kind: "deleted" };
  } catch (error) {
    if (error instanceof TossApiError && error.code === "NOT_FOUND_BILLING") {
      return { kind: "deleted" };
    }
    return { kind: "failed", error };
  }
}
