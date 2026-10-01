import { sql, type Kysely } from "kysely";

// One row per webhook delivery from Toss: what arrived, what 나루 did with
// it, and how it answered. /admin lists the recent ones, so a delivery that
// changed nothing is as visible as one that failed. Rows older than 90 days
// are pruned (lib/payments/payment-events.ts).
// `any` is required here since migrations should be frozen in time.
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable("toss_webhook_deliveries")
    .addColumn("id", "serial", (col) => col.primaryKey())
    .addColumn("received_at", "timestamptz", (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .addColumn("event_type", "text", (col) => col.notNull())
    .addColumn("transmission_id", "text")
    .addColumn("retried_count", "integer")
    .addColumn("subject", "text")
    .addColumn("toss_status", "text")
    .addColumn("outcome", "text", (col) => col.notNull())
    .addColumn("http_status", "integer", (col) => col.notNull())
    .addColumn("duration_ms", "integer", (col) => col.notNull())
    // The payload as received, with billing keys and secrets masked.
    .addColumn("payload", "text")
    .execute();
  await db.schema
    .createIndex("toss_webhook_deliveries_received_at_idx")
    .on("toss_webhook_deliveries")
    .column("received_at")
    .execute();
}

// `any` is required here since migrations should be frozen in time.
export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable("toss_webhook_deliveries").execute();
}
