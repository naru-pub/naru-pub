import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/database";
import { getPaymentByOrderId, TossApiError } from "@/lib/toss";
import { reconcilePayment } from "@/lib/payment-reconciliation";

const ALLOWED_PAYMENT_STATUSES = new Set([
  "ready",
  "in_progress",
  "waiting_for_deposit",
  "done",
  "canceled",
  "partial_canceled",
  "aborted",
  "expired",
  "failed",
]);
// General Toss payment webhooks are not signed. Treat the payload only as a
// notification and retrieve the authoritative payment before changing state.
export async function POST(request: NextRequest) {
  try {
    const rawBody = await request.text();
    const body =
      (JSON.parse(rawBody || "null") as Record<string, unknown> | null) ?? null;
    const data = (body?.data as Record<string, unknown>) ?? body ?? {};
    const orderId = data.orderId;
    if (typeof orderId !== "string") {
      return NextResponse.json({ received: true });
    }

    const ledger = await db
      .selectFrom("payments")
      .select(["id", "amount"])
      .where("order_id", "=", orderId)
      .executeTakeFirst();
    if (!ledger) return NextResponse.json({ received: true });

    const payment = await getPaymentByOrderId(orderId);
    const status = payment.status.toLowerCase();
    if (
      payment.orderId === orderId &&
      payment.totalAmount === ledger.amount &&
      ALLOWED_PAYMENT_STATUSES.has(status)
    ) {
      if (status === "canceled" || status === "partial_canceled") {
        await reconcilePayment(ledger.id);
        return NextResponse.json({ received: true });
      }
      // Successful charges must still pass through confirm/renewal, which
      // atomically records the payment and grants the paid period. Leaving a
      // successful attempt pending makes that reconciliation possible.
      await db
        .updateTable("payments")
        .set({
          toss_payment_key: payment.paymentKey,
          ...(status === "done" ? {} : { status }),
          raw: JSON.stringify(payment),
        })
        .where("id", "=", ledger.id)
        .execute();
    }

    return NextResponse.json({ received: true });
  } catch (error) {
    console.error("Toss webhook error:", error);
    if (error instanceof SyntaxError) {
      return NextResponse.json({ received: true });
    }
    // Ask Toss to retry transient lookup/database failures.
    const status =
      error instanceof TossApiError && error.status === 404 ? 200 : 503;
    return NextResponse.json({ received: status === 200 }, { status });
  }
}
