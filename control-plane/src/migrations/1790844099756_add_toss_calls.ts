import { sql, type Kysely } from "kysely";

// Every request 나루 made to Toss and what came back, so "what did Toss say"
// can be answered afterwards: the order, the HTTP status and error code, the
// bodies with billing keys and secrets masked, and how long it took. Written
// by lib/payments/toss.ts after each call; kept 5 years (lib/payments/payment-events.ts).
// `any` is required here since migrations should be frozen in time.
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable("toss_calls")
    .addColumn("id", "uuid", (col) =>
      col.primaryKey().defaultTo(sql`uuid_v7()`),
    )
    .addColumn("created_at", "timestamptz", (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .addColumn("flow", "text", (col) => col.notNull())
    .addColumn("method", "text", (col) => col.notNull())
    .addColumn("path", "text", (col) => col.notNull())
    .addColumn("order_id", "text")
    .addColumn("http_status", "integer")
    .addColumn("error_code", "text")
    .addColumn("error", "text")
    .addColumn("request_body", "jsonb")
    .addColumn("response_body", "jsonb")
    .addColumn("duration_ms", "integer", (col) => col.notNull())
    .execute();
  await db.schema
    .createIndex("toss_calls_created_at_idx")
    .on("toss_calls")
    .column("created_at")
    .execute();
  await db.schema
    .createIndex("toss_calls_order_id_idx")
    .on("toss_calls")
    .column("order_id")
    .execute();
}

// `any` is required here since migrations should be frozen in time.
export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable("toss_calls").execute();
}
