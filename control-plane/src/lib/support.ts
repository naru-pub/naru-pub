// Limited rollout: only these users see the 나루 후원 (donation) section while
// Toss Payments review is in progress.
export const SUPPORT_VISIBLE_USERS = new Set(["yang", "tosspayments"]);

// Operators can inspect and reconcile payment records across accounts.
export const PAYMENT_OPERATOR_USERS = new Set(["yang"]);
