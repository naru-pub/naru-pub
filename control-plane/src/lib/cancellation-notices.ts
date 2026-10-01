import { db } from "@/lib/database";
import {
  sendPaymentCanceledEmail,
  sendSubscriptionCanceledEmail,
  type SubscriptionCancelReason,
} from "@/lib/email";

// Mail for the two ways a billing relationship winds down: a payment canceled
// (refunded), and recurring billing stopped. Best effort, like the other
// billing mail: a failed send is logged, and never undoes the change it
// reports. Call them after the change has committed.

// Paid access left after the change, or null when none is: past, or a comp
// whose access no date describes.
function remainingAccess(user: {
  supporter_until: Date | string | null;
  supporter_comp: boolean;
}): Date | null {
  if (user.supporter_comp || !user.supporter_until) return null;
  const until = new Date(user.supporter_until);
  return until.getTime() > Date.now() ? until : null;
}

// Call it once per refund 나루 sees — when reconciliation first records the
// refunded amount — so one cancel gets one mail.
export async function sendPaymentCanceledNotice(
  paymentId: string,
  opts: { subscriptionCanceled: boolean },
): Promise<void> {
  try {
    const row = await db
      .selectFrom("payments")
      .innerJoin("users", "users.id", "payments.user_id")
      .select([
        "payments.amount",
        "payments.refunded_amount",
        "payments.refunded_at",
        "payments.order_id",
        "users.email",
        "users.email_verified_at",
        "users.login_name",
        "users.supporter_until",
        "users.supporter_comp",
      ])
      .where("payments.id", "=", paymentId)
      .executeTakeFirst();
    if (!row || !row.email || !row.email_verified_at) return;
    if (row.refunded_amount <= 0) return;

    await sendPaymentCanceledEmail({
      email: row.email,
      loginName: row.login_name,
      amount: row.amount,
      refundedAmount: row.refunded_amount,
      orderId: row.order_id,
      refundedAt: row.refunded_at ? new Date(row.refunded_at) : new Date(),
      supporterUntil: remainingAccess(row),
      subscriptionCanceled: opts.subscriptionCanceled,
    });
  } catch (error) {
    console.error(`Payment canceled notice for ${paymentId} failed:`, error);
  }
}

// Call it only from the update that moved the subscription to a stopped
// status, so one cancel gets one mail.
export async function sendSubscriptionCanceledNotice(
  subscriptionId: string,
  reason: SubscriptionCancelReason,
): Promise<void> {
  try {
    const row = await db
      .selectFrom("subscriptions")
      .innerJoin("users", "users.id", "subscriptions.user_id")
      .select([
        "subscriptions.canceled_at",
        "users.email",
        "users.email_verified_at",
        "users.login_name",
        "users.supporter_until",
        "users.supporter_comp",
      ])
      .where("subscriptions.id", "=", subscriptionId)
      .executeTakeFirst();
    if (!row || !row.email || !row.email_verified_at) return;

    await sendSubscriptionCanceledEmail({
      email: row.email,
      loginName: row.login_name,
      reason,
      canceledAt: row.canceled_at ? new Date(row.canceled_at) : new Date(),
      supporterUntil: remainingAccess(row),
    });
  } catch (error) {
    console.error(
      `Subscription canceled notice for ${subscriptionId} failed:`,
      error,
    );
  }
}
