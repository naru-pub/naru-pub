import { sql, type Kysely } from "kysely";

// One row per scheduled job, and one per process that runs them (cron, worker):
// when it last started and how often it should, so a job that stops starting —
// the cron process dead or hung, a schedule that never fires — is noticed
// (lib/scheduled-jobs.ts). stalled_at is when the operators were told it
// stalled, cleared once it runs again.
// `any` is required here since migrations should be frozen in time.
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable("cron_jobs")
    .addColumn("id", "uuid", (col) =>
      col.primaryKey().defaultTo(sql`uuid_v7()`),
    )
    .addColumn("name", "text", (col) => col.notNull().unique())
    // The process that schedules it: cron or worker.
    .addColumn("process", "text", (col) => col.notNull())
    .addColumn("every_seconds", "integer", (col) => col.notNull())
    .addColumn("last_started_at", "timestamptz", (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .addColumn("stalled_at", "timestamptz")
    .addCheckConstraint("cron_jobs_every_seconds_check", sql`every_seconds > 0`)
    .execute();
}

// `any` is required here since migrations should be frozen in time.
export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable("cron_jobs").execute();
}
