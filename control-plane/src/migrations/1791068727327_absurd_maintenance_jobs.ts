import { sql, type Kysely } from "kysely";

// `any` is required here since migrations should be frozen in time.
export async function up(db: Kysely<any>): Promise<void> {
  await sql`select absurd.create_queue('maintenance')`.execute(db);
  await db.schema
    .alterTable("cron_jobs")
    .addColumn("failed_at", "timestamptz")
    .addColumn("failure_message", "text")
    .addColumn("failure_notified", "boolean", (col) =>
      col.notNull().defaultTo(false),
    )
    .execute();
  // Worker death can exhaust a lease without returning to an application
  // handler. Retain this failure in the same commit as Absurd's terminal state.
  await sql`
    CREATE FUNCTION report_failed_maintenance_task() RETURNS trigger
    LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.state = 'failed' AND OLD.state IS DISTINCT FROM NEW.state THEN
        UPDATE cron_jobs SET failed_at = coalesce(failed_at, now()),
          failure_message = left(coalesce((SELECT failure_reason->>'message'
            FROM absurd.r_maintenance WHERE run_id = NEW.last_attempt_run),
            'Maintenance task exhausted its attempts'), 4000)
          WHERE name = CASE WHEN NEW.params->>'name' = 'template-preview'
            THEN 'screenshot-updater' ELSE NEW.params->>'name' END;
      END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER maintenance_task_failed AFTER UPDATE OF state ON absurd.t_maintenance
    FOR EACH ROW EXECUTE FUNCTION report_failed_maintenance_task();
  `.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DO $$ BEGIN RAISE EXCEPTION 'Retain unfinished maintenance tasks; deploy a forward fix'; END $$`.execute(
    db,
  );
}
