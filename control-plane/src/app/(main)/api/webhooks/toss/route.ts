import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/database";
import {
  getPaymentByOrderId,
  paymentFlowForRecord,
  paymentProviderMetadata,
  TossApiError,
} from "@/lib/toss";
import { reconcilePayment } from "@/lib/payment-reconciliation";
import { retireBillingKey } from "@/lib/billing-keys";
import { parseTossWebhook, webhookLedgerAction } from "@/lib/toss-webhooks";
// General Toss payment webhooks are not signed. Treat the payload only as a
// notification and retrieve the authoritative payment before changing state.
export async function POST(request: NextRequest) {
  const rawBody = await request.text();
  let body: unknown;
  try {
    body = JSON.parse(rawBody || "null");
  } catch {
    // Malformed payloads are not worth a retry.
    return NextResponse.json({ received: true });
  }

  try {
    const event = parseTossWebhook(body);

    if (event.type === "billing-deleted") {
      await db.transaction().execute(async (trx) => {
        const subscription = await trx
          .selectFrom("subscriptions")
          .select(["id", "canceled_at"])
          .where("toss_billing_key", "=", event.billingKey)
          .forUpdate()
          .executeTakeFirst();

        if (subscription) {
          const now = new Date();
          await trx
            .updateTable("subscriptions")
            .set({
              status: "canceled",
              next_billing_at: null,
              canceled_at: subscription.canceled_at ?? now,
              updated_at: now,
            })
            .where("id", "=", subscription.id)
            .execute();
          await retireBillingKey(
            trx,
            { subscriptionId: subscription.id },
            { deletedAtToss: true },
          );
        }
        // Toss already deleted this key, so it has nothing left to retire,
        // including a copy queued before this event arrived.
        await trx
          .deleteFrom("retired_billing_keys")
          .where("billing_key", "=", event.billingKey)
          .execute();
      });

      return NextResponse.json({ received: true });
    }

    if (event.type === "ignored") {
      return NextResponse.json({ received: true });
    }

    const orderId = event.orderId;

    const ledger = await db
      .selectFrom("payments")
      .select(["id", "amount", "attempt_key", "toss_flow"])
      .where("order_id", "=", orderId)
      .executeTakeFirst();
    if (!ledger) return NextResponse.json({ received: true });

    const payment = await getPaymentByOrderId(
      orderId,
      paymentFlowForRecord(ledger.toss_flow, ledger.attempt_key),
    );
    if (payment.orderId === orderId && payment.totalAmount === ledger.amount) {
      const action = webhookLedgerAction(payment.status);
      if (action.type === "reconcile") {
        await reconcilePayment(ledger.id);
        return NextResponse.json({ received: true });
      }
      const flow = paymentFlowForRecord(ledger.toss_flow, ledger.attempt_key);
      await db
        .updateTable("payments")
        .set({
          ...paymentProviderMetadata(payment, flow),
          toss_payment_key: payment.paymentKey,
          raw: JSON.stringify(payment),
        })
        .where("id", "=", ledger.id)
        .execute();
      if (action.type === "fail") {
        // Only an attempt still waiting on its outcome can fail; a done or
        // refunded row keeps the state that granted or revoked its period.
        await db
          .updateTable("payments")
          .set({ status: action.status })
          .where("id", "=", ledger.id)
          .where("status", "=", "pending")
          .execute();
      }
    }

    return NextResponse.json({ received: true });
  } catch (error) {
    console.error("Toss webhook error:", error);
    // Ask Toss to retry transient lookup/database failures.
    const status =
      error instanceof TossApiError && error.status === 404 ? 200 : 503;
    return NextResponse.json({ received: status === 200 }, { status });
  }
}
