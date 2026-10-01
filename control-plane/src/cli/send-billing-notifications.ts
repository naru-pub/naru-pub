import { renewalChargeAt } from "@/lib/payments/renewal-time";
// Also keeps each renewal notice in payment_mails.
import { mailRecipient } from "@/lib/payments/payment-mails";
import { db } from "@/lib/database";
import { sendSubscriptionRenewalNoticeEmail } from "@/lib/email";

const RENEWAL_NOTICE_DAYS = 3;

async function main() {
  const now = new Date();
  const noticeUntil = new Date(
    now.getTime() + RENEWAL_NOTICE_DAYS * 24 * 60 * 60 * 1000,
  );

  const dueSoon = await db
    .selectFrom("subscriptions")
    .innerJoin("users", "users.id", "subscriptions.user_id")
    .select([
      "subscriptions.id",
      "subscriptions.user_id",
      "subscriptions.amount",
      "subscriptions.current_period_start",
      "subscriptions.next_billing_at",
      "subscriptions.renewal_notice_sent_at",
    ])
    .where("subscriptions.status", "in", ["active", "scheduled"])
    .where("subscriptions.billing_key_id", "is not", null)
    .where("subscriptions.next_billing_at", ">", now)
    .where("subscriptions.next_billing_at", "<=", noticeUntil)
    // A lifetime comp is not charged, so there is nothing to announce.
    .where("users.supporter_comp", "=", false)
    .execute();

  const candidates = dueSoon.filter((sub) => {
    if (!sub.next_billing_at) return false;
    if (!sub.renewal_notice_sent_at) return true;
    if (!sub.current_period_start) return false;
    return (
      new Date(sub.renewal_notice_sent_at) < new Date(sub.current_period_start)
    );
  });

  console.log(
    `[send-billing-notifications] ${candidates.length} renewal notice(s) to send`,
  );

  for (const sub of candidates) {
    try {
      const to = await mailRecipient(sub.user_id);
      if (!to) continue;
      await sendSubscriptionRenewalNoticeEmail({
        email: to.email,
        loginName: to.loginName,
        amount: sub.amount,
        // When the renewal is actually charged: 09:00 KST on or after it
        // falls due.
        nextBillingAt: renewalChargeAt(sub.next_billing_at!),
        ref: { userId: sub.user_id, subscriptionId: sub.id },
      });

      await db
        .updateTable("subscriptions")
        .set({
          renewal_notice_sent_at: new Date(),
          updated_at: new Date(),
        })
        .where("id", "=", sub.id)
        .execute();

      console.log(
        `[send-billing-notifications] subscription ${sub.id}: renewal notice sent`,
      );
    } catch (error) {
      console.error(
        `[send-billing-notifications] subscription ${sub.id}: failed to send renewal notice:`,
        error,
      );
    }
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("[send-billing-notifications] fatal:", error);
    process.exit(1);
  });
