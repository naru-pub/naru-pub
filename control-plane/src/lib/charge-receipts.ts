import { db } from "@/lib/database";
import { sendRecurringChargeReceiptEmail } from "@/lib/email";

// Mails the supporter a receipt for a recurring charge that just landed: a
// renewal, a scheduled first charge, or either one settled late by the
// reconciler. The signup's own first charge is answered by its thank-you mail
// instead. Call it only when applySuccessfulCharge reports `granted`, so one
// payment gets one receipt. Run as a payment job (lib/payment-jobs): a failed
// send throws, and the job is tried again; it never undoes the charge.
export async function sendChargeReceipt(paymentId: string): Promise<void> {
  {
    const row = await db
      .selectFrom("payments")
      .innerJoin("users", "users.id", "payments.user_id")
      .leftJoin("subscriptions", "subscriptions.id", "payments.subscription_id")
      .select([
        "payments.amount",
        "payments.order_id",
        "payments.paid_at",
        "payments.period_start",
        "payments.period_end",
        "payments.toss_receipt_url",
        "users.email",
        "users.email_verified_at",
        "users.login_name",
        "subscriptions.status as subscription_status",
        "subscriptions.next_billing_at",
      ])
      .where("payments.id", "=", paymentId)
      .where("payments.status", "=", "done")
      .executeTakeFirst();
    if (!row || !row.email || !row.email_verified_at) return;
    if (!row.paid_at || !row.period_start || !row.period_end) return;

    await sendRecurringChargeReceiptEmail({
      email: row.email,
      loginName: row.login_name,
      amount: row.amount,
      orderId: row.order_id,
      paidAt: new Date(row.paid_at),
      periodStart: new Date(row.period_start),
      periodEnd: new Date(row.period_end),
      // A charge that landed after a cancel grants its period but renews
      // nothing, so it promises no next charge.
      nextBillingAt:
        row.subscription_status === "active" && row.next_billing_at
          ? new Date(row.next_billing_at)
          : null,
      receiptUrl: row.toss_receipt_url,
    });
  }
}
