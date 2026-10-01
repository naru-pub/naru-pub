import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/database";
import {
  getPaymentByOrderId,
  maskSecret,
  paymentFlowForRecord,
  paymentProviderMetadata,
  TossApiError,
} from "@/lib/toss";
import { reconcilePayment } from "@/lib/payment-reconciliation";
import { retireBillingKey } from "@/lib/billing-keys";
import {
  notePaymentEvent,
  recordPaymentEvent,
  recordWebhookDelivery,
} from "@/lib/payment-events";
import {
  formatWebhookLog,
  isTrustedWebhookSource,
  parseTossWebhook,
  webhookLedgerAction,
  WebhookLogEntry,
} from "@/lib/toss-webhooks";

type Delivery = Omit<WebhookLogEntry, "httpStatus" | "durationMs">;

function eventTypeOf(body: unknown): string {
  const eventType =
    body && typeof body === "object"
      ? (body as Record<string, unknown>).eventType
      : undefined;
  return typeof eventType === "string" ? eventType : "(no eventType)";
}

// General Toss payment webhooks are not signed. Treat the payload only as a
// notification and retrieve the authoritative payment before changing state.
// Every delivery is logged as one line saying what it was and what 나루 did,
// and stored (toss_webhook_deliveries) for /admin.
export async function POST(request: NextRequest) {
  const startedAt = Date.now();
  const delivery: Delivery = {
    eventType: "(unparsed)",
    transmissionId: request.headers.get("tosspayments-webhook-transmission-id"),
    retriedCount: request.headers.get(
      "tosspayments-webhook-transmission-retried-count",
    ),
    subject: null,
    tossStatus: null,
    outcome: "",
  };
  let payload: unknown = undefined;
  const respond = async (httpStatus: number, outcome: string) => {
    delivery.outcome = outcome;
    const entry = {
      ...delivery,
      httpStatus,
      durationMs: Date.now() - startedAt,
    };
    const line = formatWebhookLog(entry);
    if (httpStatus >= 500) console.error(line);
    else console.log(line);
    await recordWebhookDelivery({ ...entry, payload });
    return NextResponse.json(
      { received: httpStatus < 500 },
      { status: httpStatus },
    );
  };

  const rawBody = await request.text();
  let body: unknown;
  try {
    body = JSON.parse(rawBody || "null");
  } catch {
    // Malformed payloads are not worth a retry.
    payload = rawBody.slice(0, 2000);
    return respond(200, "ignored: malformed JSON");
  }
  payload = body;
  delivery.eventType = eventTypeOf(body);

  try {
    const event = parseTossWebhook(body);

    if (event.type === "billing-deleted") {
      delivery.subject = maskSecret(event.billingKey);
      // Acted on without a lookup, so it must at least come from Toss.
      const sourceIp = request.headers.get("cf-connecting-ip");
      if (!isTrustedWebhookSource(sourceIp)) {
        return respond(200, `ignored: untrusted address ${sourceIp}`);
      }
      const canceledId = await db.transaction().execute(async (trx) => {
        const subscription = await trx
          .selectFrom("subscriptions")
          .select(["id", "canceled_at", "user_id"])
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
          await recordPaymentEvent(trx, {
            kind: "billing_key_deleted",
            userId: subscription.user_id,
            subscriptionId: subscription.id,
            summary: `Toss에서 빌링키가 삭제됨 (BILLING_DELETED) → 정기 결제 취소`,
          });
        }
        // Toss already deleted this key, so it has nothing left to retire,
        // including a copy queued before this event arrived.
        await trx
          .deleteFrom("retired_billing_keys")
          .where("billing_key", "=", event.billingKey)
          .execute();
        return subscription?.id ?? null;
      });

      return respond(
        200,
        canceledId
          ? `canceled subscription ${canceledId}`
          : "no subscription holds this key (already retired)",
      );
    }

    if (event.type === "ignored") {
      return respond(200, "ignored: event not handled");
    }

    const orderId = event.orderId;
    delivery.subject = orderId;

    const ledger = await db
      .selectFrom("payments")
      .select([
        "id",
        "amount",
        "attempt_key",
        "toss_flow",
        "toss_mid",
        "user_id",
        "subscription_id",
      ])
      .where("order_id", "=", orderId)
      .executeTakeFirst();
    if (!ledger) return respond(200, "ignored: unknown order");

    const payment = await getPaymentByOrderId(
      orderId,
      paymentFlowForRecord(ledger.toss_flow, ledger.attempt_key),
    );
    delivery.tossStatus = payment.status;
    // Toss's checklist: the looked-up payment must match on orderId, amount
    // and MID before anything is written.
    const sameMid =
      ledger.toss_mid == null ||
      payment.mId == null ||
      payment.mId === ledger.toss_mid;
    if (
      payment.orderId !== orderId ||
      payment.totalAmount !== ledger.amount ||
      !sameMid
    ) {
      return respond(
        200,
        `ignored: lookup does not match payment ${ledger.id} (amount ${payment.totalAmount}/${ledger.amount}, mId ${payment.mId}/${ledger.toss_mid})`,
      );
    }

    const action = webhookLedgerAction(payment.status);
    if (action.type === "reconcile") {
      // Toss wants an answer within 10 seconds; a key the refund retires is
      // deleted by the cron instead.
      const result = await reconcilePayment(ledger.id, {
        deferKeyDeletion: true,
      });
      return respond(
        200,
        `reconciled payment ${ledger.id}: ${JSON.stringify(result)}`,
      );
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
      const failed = await db
        .updateTable("payments")
        .set({ status: action.status })
        .where("id", "=", ledger.id)
        .where("status", "=", "pending")
        .executeTakeFirst();
      if (Number(failed.numUpdatedRows ?? 0) > 0) {
        await notePaymentEvent({
          kind: action.status === "expired" ? "order_expired" : "charge_failed",
          userId: ledger.user_id,
          paymentId: ledger.id,
          subscriptionId: ledger.subscription_id,
          summary: `주문 ${orderId} (${ledger.amount.toLocaleString("ko-KR")}원): 웹훅으로 Toss 상태 ${payment.status} 확인`,
        });
      }
      return respond(
        200,
        Number(failed.numUpdatedRows ?? 0) > 0
          ? `payment ${ledger.id} pending -> ${action.status}`
          : `payment ${ledger.id} already settled; recorded only`,
      );
    }
    return respond(200, `payment ${ledger.id} recorded only`);
  } catch (error) {
    // Ask Toss to retry transient lookup/database failures.
    const status =
      error instanceof TossApiError && error.status === 404 ? 200 : 503;
    if (status === 503) console.error("Toss webhook error:", error);
    return respond(
      status,
      `${status === 200 ? "ignored" : "error, Toss will retry"}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
