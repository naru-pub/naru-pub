import { sql, type Kysely } from "kysely";

// Durable work the payment code owes after a change: the mail a supporter is
// owed, a webhook's reconciliation. A job is written in the same transaction
// as the change it follows, so it exists exactly when the change does; the
// request runs it right after committing, and the run-payment-jobs cron
// retries what failed, with backoff, until it succeeds or gives up
// (lib/payment-jobs.ts).
//
// dedupe_key keeps one job per thing owed — one receipt per payment, one
// cancel mail per cancel — however often the code that owes it runs.
// `any` is required here since migrations should be frozen in time.
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable("payment_jobs")
    .addColumn("id", "uuid", (col) =>
      col.primaryKey().defaultTo(sql`uuid_v7()`),
    )
    .addColumn("created_at", "timestamptz", (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .addColumn("kind", "text", (col) => col.notNull())
    .addColumn("payload", "jsonb", (col) => col.notNull())
    .addColumn("dedupe_key", "text", (col) => col.unique())
    .addColumn("run_at", "timestamptz", (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .addColumn("attempts", "integer", (col) => col.notNull().defaultTo(0))
    .addColumn("locked_until", "timestamptz")
    .addColumn("last_error", "text")
    .addColumn("done_at", "timestamptz")
    .addColumn("failed_at", "timestamptz")
    .execute();
  await sql`
    CREATE INDEX payment_jobs_due_idx ON payment_jobs (run_at)
    WHERE done_at IS NULL AND failed_at IS NULL
  `.execute(db);
}

// `any` is required here since migrations should be frozen in time.
export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable("payment_jobs").execute();
}
