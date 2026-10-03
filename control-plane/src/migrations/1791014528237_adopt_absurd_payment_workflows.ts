import { sql, type Kysely } from "kysely";
import { absurdSchema } from "./vendor/absurd-0.5.0";

// `any` is required here since migrations should be frozen in time.
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable("payments")
    .addColumn("refund_requested_at", "timestamptz")
    .addColumn("refund_subscription_id", "uuid", (col) =>
      col.references("subscriptions.id").onDelete("set null"),
    )
    .execute();
  await sql.raw(absurdSchema).execute(db);
  await sql`select absurd.create_queue('payments')`.execute(db);

  // Deployment stops all old producers/consumers before this migration.
  // Import unfinished work even if a stopped worker left a claim behind.
  await sql`lock table payment_jobs in access exclusive mode`.execute(db);

  // Import history too: completed/failed jobs retain their dedupe identities.
  // Direct table writes here only import state into the pinned vendor schema.
  await sql`
    DO $$ DECLARE j record; t record; BEGIN
      FOR j IN SELECT * FROM payment_jobs ORDER BY created_at LOOP
        SELECT * INTO t FROM absurd.spawn_task('payments', 'payment-job-v1',
          jsonb_build_object('job', j.payload),
          jsonb_build_object('idempotency_key', j.dedupe_key,
            'max_attempts', greatest(1, 8 - j.attempts),
            'retry_strategy', jsonb_build_object('kind', 'exponential',
              'base_seconds', 60, 'factor', 2, 'max_seconds', 21600)));
        IF j.done_at IS NOT NULL OR j.failed_at IS NOT NULL THEN
          UPDATE absurd.t_payments SET state = CASE WHEN j.done_at IS NOT NULL
            THEN 'completed' ELSE 'failed' END WHERE task_id = t.task_id;
          UPDATE absurd.r_payments SET state = CASE WHEN j.done_at IS NOT NULL
            THEN 'completed' ELSE 'failed' END, completed_at = j.done_at,
            failed_at = j.failed_at,
            failure_reason = jsonb_build_object('message', j.last_error)
            WHERE run_id = t.run_id;
        ELSE
          UPDATE absurd.r_payments SET available_at = j.run_at WHERE run_id = t.run_id;
        END IF;
      END LOOP;
    END $$
  `.execute(db);

  await db.schema.dropTable("payment_jobs").execute();

  // Report terminal failure in the same commit as the task state, including
  // failures detected while reclaiming a dead worker's last lease. A process
  // dying between fail_run and an application alert cannot lose this event.
  await sql`
    CREATE FUNCTION report_failed_payment_task() RETURNS trigger
    LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.state = 'failed' AND OLD.state IS DISTINCT FROM NEW.state THEN
        INSERT INTO payment_events (kind, summary) VALUES ('job_failed',
          '결제 후속 작업 ' || NEW.task_name || ' (' || NEW.task_id || ')가 실패해 멈췄습니다: ' ||
          left(coalesce((SELECT failure_reason->>'message' FROM absurd.r_payments
            WHERE run_id = NEW.last_attempt_run), ''), 300));
      END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER payments_task_failed_event AFTER UPDATE OF state ON absurd.t_payments
    FOR EACH ROW EXECUTE FUNCTION report_failed_payment_task();
  `.execute(db);
}

// `any` is required here since migrations should be frozen in time.
export async function down(db: Kysely<any>): Promise<void> {
  // Dropping workflow state would silently lose money operations and mail.
  // Deploy a forward fix instead of reviving code that uses the dropped queue.
  await sql`DO $$ BEGIN RAISE EXCEPTION 'Absurd migration is forward-only; retain its durable tasks'; END $$`.execute(
    db,
  );
}
