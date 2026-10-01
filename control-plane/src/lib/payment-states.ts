// The states a plan (subscriptions.status) and a payment (payments.status)
// can be in, and the only changes between them. The database enforces the
// same table — a trigger refuses any other status change (see the migration
// that adds payment_status_transitions) — and a test checks that the two
// agree, so a new code path that moves a status somewhere it may not go fails
// at the write, not in a review.

export const SUBSCRIPTION_STATUSES = [
  // A signup holding its key, before its first charge.
  "incomplete",
  "active",
  // Its first charge waits for prepaid time to run out.
  "scheduled",
  // Renewals stopped: retries spent, or the grace period over.
  "past_due",
  "canceled",
] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

// Where each plan state may go. Staying put is always allowed; canceled is
// final.
export const SUBSCRIPTION_TRANSITIONS: Record<
  SubscriptionStatus,
  readonly SubscriptionStatus[]
> = {
  incomplete: ["active", "scheduled", "canceled"],
  scheduled: ["active", "past_due", "canceled"],
  active: ["past_due", "canceled"],
  // A charge left unresolved turns out paid after all.
  past_due: ["active", "canceled"],
  canceled: [],
};

// The plans still live: at most one per account (a unique index).
export const LIVE_SUBSCRIPTION_STATUSES: readonly SubscriptionStatus[] = [
  "incomplete",
  "active",
  "scheduled",
  "past_due",
];
// A one-time purchase is not offered beside a plan in these: one that charges,
// or may again (past due, revived if a charge it left unresolved turns out
// paid). The supporter cancels it first.
export const ONE_TIME_BLOCKING_STATUSES: readonly SubscriptionStatus[] = [
  "active",
  "scheduled",
  "past_due",
];
export const ENDED_SUBSCRIPTION_STATUSES: readonly SubscriptionStatus[] = [
  "canceled",
];

export const PAYMENT_STATUSES = [
  // Sent, or about to be; the outcome is not known yet.
  "pending",
  "done",
  // Declined on its merits.
  "failed",
  // Toss ended the order without approving it.
  "aborted",
  "expired",
  // Refunded, in full or — from the Toss dashboard — in part: 나루 sells no
  // partial refunds, so either undoes the purchase.
  "canceled",
] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

export const PAYMENT_TRANSITIONS: Record<
  PaymentStatus,
  readonly PaymentStatus[]
> = {
  pending: ["done", "failed", "aborted", "expired", "canceled"],
  done: ["canceled"],
  // An order settled as not charged that Toss in fact approved goes back to
  // pending, to be granted like any other (recoverOrphanedCharge).
  failed: ["pending"],
  aborted: ["pending"],
  expired: ["pending"],
  canceled: [],
};

// Narrows a status read from elsewhere (Toss, a query string) to one of these.
export function isOneOf<T extends string>(
  statuses: readonly T[],
  value: string,
): value is T {
  return (statuses as readonly string[]).includes(value);
}

export function canMoveSubscription(
  from: SubscriptionStatus,
  to: SubscriptionStatus,
): boolean {
  return from === to || SUBSCRIPTION_TRANSITIONS[from].includes(to);
}

export function canMovePayment(from: PaymentStatus, to: PaymentStatus) {
  return from === to || PAYMENT_TRANSITIONS[from].includes(to);
}
