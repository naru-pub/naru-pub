import { sql, type Kysely } from "kysely";

// Payment and billing events — a charge, a decline, a refund, a cancel —
// recorded where they happen, mostly in the same transaction. In production
// they are mailed to the operators in digests (emailed_at marks what went
// out), and /admin lists the recent ones.
// `any` is required here since migrations should be frozen in time.
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable("payment_events")
    .addColumn("id", "serial", (col) => col.primaryKey())
    .addColumn("created_at", "timestamptz", (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .addColumn("kind", "text", (col) => col.notNull())
    .addColumn("user_id", "integer", (col) =>
      col.references("users.id").onDelete("set null"),
    )
    .addColumn("payment_id", "integer", (col) =>
      col.references("payments.id").onDelete("set null"),
    )
    .addColumn("subscription_id", "integer", (col) =>
      col.references("subscriptions.id").onDelete("set null"),
    )
    .addColumn("summary", "text", (col) => col.notNull())
    .addColumn("emailed_at", "timestamptz")
    .execute();
  await db.schema
    .createIndex("payment_events_unsent_idx")
    .on("payment_events")
    .column("id")
    .where(sql.ref("emailed_at"), "is", null)
    .execute();
  await db.schema
    .createIndex("payment_events_created_at_idx")
    .on("payment_events")
    .column("created_at")
    .execute();
}

// `any` is required here since migrations should be frozen in time.
export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable("payment_events").execute();
}
