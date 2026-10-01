import type { Kysely } from "kysely";

// The headers each webhook delivery came with. Toss's docs disagree on whether
// payment and billing events are signed (a Toss-Signature header on every
// event, says one release note; tosspayments-webhook-signature on payout and
// seller events only, say the webhook pages). The deliveries themselves settle
// it. Stored as JSON text, like the payload, with the result of checking any
// signature against 나루's secret keys (checkWebhookSignature).
// `any` is required here since migrations should be frozen in time.
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable("toss_webhook_deliveries")
    .addColumn("headers", "text")
    .addColumn("signature_check", "text")
    .execute();
}

// `any` is required here since migrations should be frozen in time.
export async function down(db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable("toss_webhook_deliveries")
    .dropColumn("headers")
    .dropColumn("signature_check")
    .execute();
}
