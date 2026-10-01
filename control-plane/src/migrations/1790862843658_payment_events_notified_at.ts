import { type Kysely } from "kysely";

// Payment events reach the operators in a Discord channel now, not by mail
// (lib/operator-alerts.ts): when one was sent is notified_at.
// `any` is required here since migrations should be frozen in time.
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable("payment_events")
    .renameColumn("emailed_at", "notified_at")
    .execute();
}

// `any` is required here since migrations should be frozen in time.
export async function down(db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable("payment_events")
    .renameColumn("notified_at", "emailed_at")
    .execute();
}
