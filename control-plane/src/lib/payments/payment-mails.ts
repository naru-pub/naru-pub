import { db } from "@/lib/database";
import { setPaymentMailRecorder, type PaymentMailRecord } from "@/lib/email";

// Keeps every payment mail in payment_mails (see the migration that adds it):
// what was sent to whom about which payment or plan, and the provider's
// message id or why it failed. Best effort: a mail whose record cannot be
// written was still sent. Imported for its effect by the code that sends
// payment mail (lib/payments/payment-jobs.ts, the renewal notice and digest crons).
async function keepPaymentMail(record: PaymentMailRecord): Promise<void> {
  try {
    await db
      .insertInto("payment_mails")
      .values({
        kind: record.kind,
        user_id: record.ref.userId ?? null,
        payment_id: record.ref.paymentId ?? null,
        subscription_id: record.ref.subscriptionId ?? null,
        recipient: record.recipient.slice(0, 320),
        message_id: record.messageId?.slice(0, 200) ?? null,
        error: record.error?.slice(0, 2000) ?? null,
      })
      .execute();
  } catch (error) {
    console.error("Payment mail could not be recorded:", error);
  }
}

if (process.env.DATABASE_URL) setPaymentMailRecorder(keepPaymentMail);

export type MailRecipient = {
  userId: string;
  email: string;
  loginName: string;
  supporterUntil: Date | null;
  supporterComp: boolean;
};

// Who a payment mail goes to: the account, if it has a verified address.
// Null otherwise — the mail is skipped, which is not a failure to retry. The
// one rule every payment mail follows.
export async function mailRecipient(
  userId: string,
): Promise<MailRecipient | null> {
  const user = await db
    .selectFrom("users")
    .select([
      "email",
      "email_verified_at",
      "login_name",
      "supporter_until",
      "supporter_comp",
    ])
    .where("id", "=", userId)
    .executeTakeFirst();
  if (!user?.email || !user.email_verified_at) return null;
  return {
    userId,
    email: user.email,
    loginName: user.login_name,
    supporterUntil: user.supporter_until
      ? new Date(user.supporter_until)
      : null,
    supporterComp: user.supporter_comp,
  };
}
