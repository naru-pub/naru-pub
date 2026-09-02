// Operators can inspect and reconcile payment records across accounts.
export const PAYMENT_OPERATOR_USERS = new Set(["yang"]);

// Supporting 나루 opens a billing relationship we have to be able to reach the
// supporter about — thank-you receipts, renewal notices, failed charges — so a
// verified email address is a precondition for starting any purchase.
export function hasVerifiedEmail(user: {
  email: string | null;
  emailVerifiedAt: Date | null;
}): boolean {
  return user.email !== null && user.emailVerifiedAt !== null;
}

export const EMAIL_VERIFICATION_REQUIRED_MESSAGE =
  "후원하려면 먼저 이메일 주소를 인증해 주세요.";
