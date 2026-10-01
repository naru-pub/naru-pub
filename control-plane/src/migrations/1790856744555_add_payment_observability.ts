import { sql, type Kysely } from "kysely";

// What payments leave nowhere else, so support questions have answers:
//
// - toss_window_outcomes: how a Toss payment or card window ended when it did
//   not succeed — the code and message Toss gives the failUrl or the popup's
//   rejection, which no API call ever sees. Kept 5 years, like toss_calls.
// - payment_mails: each payment mail sent or failed, to whom, with the
//   provider's message id. Kept 1 year (it holds addresses).
// - payment_cron_runs: each run of a payment cron job, how it ended and the
//   last of what it printed. Kept 1 year.
// `any` is required here since migrations should be frozen in time.
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable("toss_window_outcomes")
    .addColumn("id", "uuid", (col) =>
      col.primaryKey().defaultTo(sql`uuid_v7()`),
    )
    .addColumn("created_at", "timestamptz", (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .addColumn("user_id", "uuid", (col) =>
      col.references("users.id").onDelete("set null"),
    )
    // billing_auth (card registration) or payment (one-time).
    .addColumn("window", "text", (col) => col.notNull())
    .addColumn("card_registration_id", "uuid", (col) =>
      col.references("card_registrations.id").onDelete("set null"),
    )
    .addColumn("order_id", "text")
    .addColumn("code", "text", (col) => col.notNull())
    .addColumn("message", "text")
    .addCheckConstraint(
      "toss_window_outcomes_window_check",
      sql`"window" in ('billing_auth', 'payment')`,
    )
    .execute();
  // One row per window and code: a reloaded page reports it again.
  await sql`
    CREATE UNIQUE INDEX toss_window_outcomes_once_idx ON toss_window_outcomes
    (coalesce(card_registration_id::text, order_id), code)
  `.execute(db);
  await db.schema
    .createIndex("toss_window_outcomes_created_at_idx")
    .on("toss_window_outcomes")
    .column("created_at")
    .execute();

  await db.schema
    .createTable("payment_mails")
    .addColumn("id", "uuid", (col) =>
      col.primaryKey().defaultTo(sql`uuid_v7()`),
    )
    .addColumn("created_at", "timestamptz", (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .addColumn("kind", "text", (col) => col.notNull())
    .addColumn("user_id", "uuid", (col) =>
      col.references("users.id").onDelete("set null"),
    )
    .addColumn("payment_id", "uuid", (col) =>
      col.references("payments.id").onDelete("set null"),
    )
    .addColumn("subscription_id", "uuid", (col) =>
      col.references("subscriptions.id").onDelete("set null"),
    )
    .addColumn("recipient", "text", (col) => col.notNull())
    .addColumn("message_id", "text")
    .addColumn("error", "text")
    .execute();
  await db.schema
    .createIndex("payment_mails_user_id_idx")
    .on("payment_mails")
    .columns(["user_id", "id"])
    .execute();
  await db.schema
    .createIndex("payment_mails_created_at_idx")
    .on("payment_mails")
    .column("created_at")
    .execute();

  await db.schema
    .createTable("payment_cron_runs")
    .addColumn("id", "uuid", (col) =>
      col.primaryKey().defaultTo(sql`uuid_v7()`),
    )
    .addColumn("script", "text", (col) => col.notNull())
    .addColumn("started_at", "timestamptz", (col) => col.notNull())
    .addColumn("finished_at", "timestamptz", (col) => col.notNull())
    .addColumn("exit_code", "integer")
    .addColumn("timed_out", "boolean", (col) => col.notNull())
    .addColumn("output_tail", "text")
    .execute();
  await db.schema
    .createIndex("payment_cron_runs_script_idx")
    .on("payment_cron_runs")
    .columns(["script", "started_at"])
    .execute();
}

// `any` is required here since migrations should be frozen in time.
export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable("payment_cron_runs").execute();
  await db.schema.dropTable("payment_mails").execute();
  await db.schema.dropTable("toss_window_outcomes").execute();
}
