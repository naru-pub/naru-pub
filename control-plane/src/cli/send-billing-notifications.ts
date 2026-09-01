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
      "subscriptions.amount",
      "subscriptions.current_period_start",
      "subscriptions.next_billing_at",
      "subscriptions.renewal_notice_sent_at",
      "users.email",
      "users.login_name",
    ])
    .where("subscriptions.status", "in", ["active", "scheduled"])
    .where("subscriptions.toss_billing_key", "is not", null)
    .where("subscriptions.next_billing_at", ">", now)
    .where("subscriptions.next_billing_at", "<=", noticeUntil)
    .where("users.email", "is not", null)
    .where("users.email_verified_at", "is not", null)
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
      await sendSubscriptionRenewalNoticeEmail({
        email: sub.email!,
        loginName: sub.login_name,
        amount: sub.amount,
        nextBillingAt: new Date(sub.next_billing_at!),
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
        `[send-billing-notifications] user ${sub.login_name}: renewal notice sent`,
      );
    } catch (error) {
      console.error(
        `[send-billing-notifications] user ${sub.login_name}: failed to send renewal notice:`,
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
