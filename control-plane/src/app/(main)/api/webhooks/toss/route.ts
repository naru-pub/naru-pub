import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/database";
import {
  maskSecret,
  paymentFlowForRecord,
  paymentProviderMetadata,
  TossApiError,
  tossSecretKeys,
} from "@/lib/payments/toss";
import { markDeletedAtToss } from "@/lib/payments/billing-keys";
import { endPlan } from "@/lib/payments/subscriptions";
import { withAccountLock } from "@/lib/payments/account-lock";
import { lookupOrder } from "@/lib/payments/toss-gateway";
import { enqueueJob, runJobs } from "@/lib/payments/payment-jobs";
import { recordWebhookDelivery } from "@/lib/payments/payment-events";
import {
  formatWebhookLog,
  isTrustedWebhookSource,
  parseTossWebhook,
  readCappedBody,
  checkWebhookSignature,
  storedWebhookHeaders,
  webhookLedgerAction,
  WebhookLogEntry,
} from "@/lib/payments/toss-webhooks";

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
  const headers = storedWebhookHeaders(request.headers);
  const delivery: Delivery = {
    eventType: "(unparsed)",
    transmissionId: request.headers.get("tosspayments-webhook-transmission-id"),
    retriedCount: request.headers.get(
      "tosspayments-webhook-transmission-retried-count",
    ),
    signature: null,
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
    await recordWebhookDelivery({ ...entry, payload, headers });
    return NextResponse.json(
      { received: httpStatus < 500 },
      { status: httpStatus },
    );
  };

  const rawBody = await readCappedBody(request);
  if (rawBody === null) {
    // Not a Toss webhook; nothing of it is read, hashed or stored.
    return respond(413, "ignored: body too large");
  }
  delivery.signature = checkWebhookSignature({
    rawBody,
    headers,
    keys: tossSecretKeys(),
  });
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
      // Under the owner's account lock (lib/payments/account-lock): no charge or card
      // change on that plan runs while it is canceled.
      const key = await db
        .selectFrom("billing_keys")
        .select(["id", "user_id"])
        .where("billing_key", "=", event.billingKey)
        .executeTakeFirst();
      const cancelPlan = () =>
        db.transaction().execute(async (trx) => {
          if (!key) return null;
          const holder = await trx
            .selectFrom("subscriptions")
            .select("id")
            .where("billing_key_id", "=", key.id)
            .executeTakeFirst();
          const ended = holder
            ? await endPlan(trx, holder.id, {
                summary: () =>
                  "Toss에서 빌링키가 삭제됨 (BILLING_DELETED) → 정기 결제 취소",
                eventKind: "billing_key_deleted",
                notice: "billing_key_deleted",
                keyDeletedAtToss: true,
              })
            : null;
          // Toss already deleted this key, so it has nothing left to retire,
          // including a key retired before this event arrived.
          await markDeletedAtToss(trx, key.id);
          return holder && ended
            ? { id: holder.id, noticeJob: ended.noticeJob }
            : null;
        });
      const canceled = key?.user_id
        ? await withAccountLock(key.user_id, { waitMs: 5000 }, cancelPlan)
        : await cancelPlan();
      await runJobs([canceled?.noticeJob ?? null]);

      return respond(
        200,
        canceled
          ? `canceled subscription ${canceled.id}`
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

    const found = await lookupOrder(
      orderId,
      paymentFlowForRecord(ledger.toss_flow, ledger.attempt_key),
    );
    if (found.kind === "not_found") {
      return respond(200, "ignored: Toss has no such order");
    }
    // A lookup that failed is retried by Toss (503 below).
    if (found.kind === "unknown") throw found.error;
    const payment = found.payment;
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

    // A cancel, or an order Toss ended without approving it (ABORTED,
    // EXPIRED): reconciliation brings the ledger, the paid time and the plan
    // in line under the account lock, as it does for every other path. It is
    // a payment job, tried here at once and, when the account is busy or Toss
    // does not answer, by the run-payment-jobs cron after; the webhook is
    // answered either way. A key that frees is deleted by the cron, not here
    // inside Toss's 10 seconds.
    const action = webhookLedgerAction(payment.status);
    if (action.type === "reconcile" || action.type === "fail") {
      const job = await enqueueJob(db, {
        kind: "reconcile_payment",
        paymentId: ledger.id,
      });
      await runJobs([job]);
      return respond(200, `reconcile job ${job} for payment ${ledger.id}`);
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
