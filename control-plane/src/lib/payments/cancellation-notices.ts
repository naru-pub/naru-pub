import { db } from "@/lib/database";
import { addPaymentGrace } from "@/lib/payments/subscriptions";
import {
  mailRecipient,
  type MailRecipient,
} from "@/lib/payments/payment-mails";
import {
  sendPaymentCanceledEmail,
  sendSubscriptionCanceledEmail,
  type SubscriptionCancelReason,
} from "@/lib/email";

// Mail for the two ways a billing relationship winds down: a payment canceled
// (refunded), and recurring billing stopped. Run as payment jobs
// (lib/payments/payment-jobs): a failed send throws and is tried again; it never undoes
// the change it reports.

// When paid features actually end after the change, or null when they
// already have (or a comp, whose access no date describes): the paid time
// left, and past it the payment grace window entitlements grant, which a
// refund does not take away.
function remainingAccess(user: MailRecipient): Date | null {
  if (user.supporterComp || !user.supporterUntil) return null;
  const until = user.supporterUntil;
  if (until.getTime() > Date.now()) return until;
  const graceEndsAt = addPaymentGrace(until);
  return graceEndsAt.getTime() > Date.now() ? graceEndsAt : null;
}

// Call it once per refund 나루 sees — when reconciliation first records the
// refunded amount — so one cancel gets one mail.
export async function sendPaymentCanceledNotice(
  paymentId: string,
  opts: { subscriptionCanceled: boolean },
): Promise<void> {
  {
    const row = await db
      .selectFrom("payments")
      .select([
        "user_id",
        "amount",
        "refunded_amount",
        "refunded_at",
        "order_id",
      ])
      .where("id", "=", paymentId)
      .executeTakeFirst();
    if (!row || row.refunded_amount <= 0) return;
    const to = await mailRecipient(row.user_id);
    if (!to) return;

    await sendPaymentCanceledEmail({
      email: to.email,
      loginName: to.loginName,
      amount: row.amount,
      refundedAmount: row.refunded_amount,
      orderId: row.order_id,
      refundedAt: row.refunded_at ? new Date(row.refunded_at) : new Date(),
      supporterUntil: remainingAccess(to),
      subscriptionCanceled: opts.subscriptionCanceled,
      ref: { userId: row.user_id, paymentId },
    });
  }
}

// Call it only from the update that moved the subscription to a stopped
// status, so one cancel gets one mail.
export async function sendSubscriptionCanceledNotice(
  subscriptionId: string,
  reason: SubscriptionCancelReason,
): Promise<void> {
  {
    const row = await db
      .selectFrom("subscriptions")
      .select(["user_id", "canceled_at"])
      .where("id", "=", subscriptionId)
      .executeTakeFirst();
    if (!row) return;
    const to = await mailRecipient(row.user_id);
    if (!to) return;

    await sendSubscriptionCanceledEmail({
      email: to.email,
      loginName: to.loginName,
      reason,
      canceledAt: row.canceled_at ? new Date(row.canceled_at) : new Date(),
      supporterUntil: remainingAccess(to),
      ref: { userId: row.user_id, subscriptionId },
    });
  }
}
