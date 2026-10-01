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
  // Ended by a one-time purchase.
  "switched_to_one_time",
] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

// Where each plan state may go. Staying put is always allowed. The ended
// states are final but for one: a one-time purchase records that it replaced
// a plan already canceled.
export const SUBSCRIPTION_TRANSITIONS: Record<
  SubscriptionStatus,
  readonly SubscriptionStatus[]
> = {
  incomplete: ["active", "scheduled", "canceled", "switched_to_one_time"],
  scheduled: ["active", "past_due", "canceled", "switched_to_one_time"],
  active: ["past_due", "canceled", "switched_to_one_time"],
  // A charge left unresolved turns out paid after all.
  past_due: ["active", "canceled", "switched_to_one_time"],
  canceled: ["switched_to_one_time"],
  switched_to_one_time: [],
};

// The plans still live: at most one per account (a unique index).
export const LIVE_SUBSCRIPTION_STATUSES: readonly SubscriptionStatus[] = [
  "incomplete",
  "active",
  "scheduled",
  "past_due",
];
export const ENDED_SUBSCRIPTION_STATUSES: readonly SubscriptionStatus[] = [
  "canceled",
  "switched_to_one_time",
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
  "canceled",
  "partial_canceled",
] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

export const PAYMENT_TRANSITIONS: Record<
  PaymentStatus,
  readonly PaymentStatus[]
> = {
  pending: [
    "done",
    "failed",
    "aborted",
    "expired",
    "canceled",
    "partial_canceled",
  ],
  done: ["canceled", "partial_canceled"],
  // An order settled as not charged that Toss in fact approved goes back to
  // pending, to be granted like any other (recoverOrphanedCharge).
  failed: ["pending"],
  aborted: ["pending"],
  expired: ["pending"],
  partial_canceled: ["canceled"],
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
