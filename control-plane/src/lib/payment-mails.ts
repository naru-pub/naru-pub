import { db } from "@/lib/database";
import { setPaymentMailRecorder, type PaymentMailRecord } from "@/lib/email";

// Keeps every payment mail in payment_mails (see the migration that adds it):
// what was sent to whom about which payment or plan, and the provider's
// message id or why it failed. Best effort: a mail whose record cannot be
// written was still sent. Imported for its effect by the code that sends
// payment mail (lib/payment-jobs.ts, the renewal notice and digest crons).
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
