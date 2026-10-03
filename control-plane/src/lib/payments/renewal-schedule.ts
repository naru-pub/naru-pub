import { Client } from "pg";
import { sql } from "kysely";
import { db } from "@/lib/database";
import {
  PAYMENT_QUEUE,
  PAYMENT_TASK,
  PAYMENT_RETRY_OPTIONS,
} from "@/lib/payments/payment-jobs";

export const RENEWAL_SCHEDULE_NAME = "naru-renewal-scan";
export const RENEWAL_SCHEDULE = "0 * * * *";
// Static SQL only; pg_cron executes this in the application database. The UTC
// hour's key collapses deployment catch-up and duplicate scheduler triggers.
export const RENEWAL_SCAN_COMMAND = `select absurd.spawn_task(
  '${PAYMENT_QUEUE}', '${PAYMENT_TASK}', '{"job":{"kind":"enqueue_due_renewals"}}'::jsonb,
  '${JSON.stringify(PAYMENT_RETRY_OPTIONS)}'::jsonb || jsonb_build_object(
    'idempotency_key', 'renewal-scan:' || extract(epoch from date_trunc('hour', now() at time zone 'UTC') at time zone 'UTC')::bigint::text
  )
);`;

// A deployment operation, not a second runtime scheduler. pg_cron's metadata
// may live in another database; schedule_in_database targets the app explicitly.
export async function configureRenewalSchedule() {
  const {
    rows: [config],
  } = await sql<{
    database: string;
    username: string;
    cron_database: string | null;
  }>`select current_database() as database, current_user as username,
    current_setting('cron.database_name', true) as cron_database`.execute(db);
  if (!config.cron_database)
    throw new Error(
      "pg_cron must be installed and preloaded before configuring renewal scheduling",
    );
  const connectionString = new URL(process.env.DATABASE_URL!);
  connectionString.pathname = `/${encodeURIComponent(config.cron_database)}`;
  const client = new Client({ connectionString: connectionString.toString() });
  try {
    await client.connect();
    await client.query("create extension if not exists pg_cron");
    await client.query("select cron.schedule_in_database($1, $2, $3, $4, $5)", [
      RENEWAL_SCHEDULE_NAME,
      RENEWAL_SCHEDULE,
      RENEWAL_SCAN_COMMAND,
      config.database,
      config.username,
    ]);
    // Catch up after downtime now rather than waiting for the next hour.
    await sql.raw(RENEWAL_SCAN_COMMAND).execute(db);
  } finally {
    await client.end();
  }
}
