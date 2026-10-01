import { db } from "@/lib/database";
import { sendRecurringChargeReceiptEmail } from "@/lib/email";
import { mailRecipient } from "@/lib/payments/payment-mails";

// Mails the supporter a receipt for a recurring charge that just landed: a
// renewal, a scheduled first charge, or either one settled late by the
// reconciler. The signup's own first charge is answered by its thank-you mail
// instead. Call it only when applySuccessfulCharge reports `granted`, so one
// payment gets one receipt. Run as a payment job (lib/payments/payment-jobs): a failed
// send throws, and the job is tried again; it never undoes the charge.
export async function sendChargeReceipt(paymentId: string): Promise<void> {
  {
    const row = await db
      .selectFrom("payments")
      .leftJoin("subscriptions", "subscriptions.id", "payments.subscription_id")
      .select([
        "payments.user_id",
        "payments.subscription_id",
        "payments.amount",
        "payments.order_id",
        "payments.paid_at",
        "payments.period_start",
        "payments.period_end",
        "payments.toss_receipt_url",
        "subscriptions.status as subscription_status",
        "subscriptions.next_billing_at",
      ])
      .where("payments.id", "=", paymentId)
      .where("payments.status", "=", "done")
      .executeTakeFirst();
    if (!row || !row.paid_at || !row.period_start || !row.period_end) return;
    const to = await mailRecipient(row.user_id);
    if (!to) return;

    await sendRecurringChargeReceiptEmail({
      email: to.email,
      loginName: to.loginName,
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
      ref: {
        userId: row.user_id,
        paymentId,
        subscriptionId: row.subscription_id,
      },
    });
  }
}
