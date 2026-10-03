import { Client } from "pg";
import { sql } from "kysely";
import { db } from "@/lib/database";
import { registerJobs } from "@/lib/scheduled-jobs";
import {
  MAINTENANCE_JOBS,
  SCHEDULED_JOBS,
  MAINTENANCE_QUEUE,
  MAINTENANCE_TASK,
  MAINTENANCE_RETRY_OPTIONS,
  type MaintenanceJob,
} from "./jobs";
import {
  RENEWAL_SCHEDULE_NAME,
  RENEWAL_SCHEDULE,
  RENEWAL_SCAN_COMMAND,
} from "@/lib/payments/renewal-schedule";

// Probe daily slots hourly: normally every probe dedupes until the scheduled
// UTC hour, but a database outage does not postpone a missed run until tomorrow.
export function maintenanceSchedule(job: MaintenanceJob): string {
  return job.hour !== undefined
    ? `${job.minute} * * * *`
    : `*/${job.minutes} * * * *`;
}
// Catalog values only, never user input. A daily slot is anchored at its UTC
// scheduled time; periodic slots are anchored at epoch minute zero.
export function maintenanceCommand(job: MaintenanceJob): string {
  const offset = (job.hour ?? 0) * 3600 + (job.minute ?? 0) * 60;
  return `select absurd.spawn_task('${MAINTENANCE_QUEUE}', '${MAINTENANCE_TASK}',
    '${JSON.stringify({ name: job.name })}'::jsonb,
    '${JSON.stringify(MAINTENANCE_RETRY_OPTIONS)}'::jsonb || jsonb_build_object(
      'idempotency_key', 'maintenance:${job.name}:' || floor((extract(epoch from now()) - ${offset}) / ${job.minutes * 60})::bigint::text
    ));`;
}
export async function configureSchedules(): Promise<void> {
  const {
    rows: [config],
  } = await sql<{
    database: string;
    username: string;
    cron_database: string | null;
    timezone: string | null;
  }>`
    select current_database() as database, current_user as username,
      current_setting('cron.database_name', true) as cron_database,
      current_setting('cron.timezone', true) as timezone
  `.execute(db);
  if (!config.cron_database)
    throw new Error(
      "pg_cron must be installed and preloaded before configuring schedules",
    );
  // Expressions below deliberately use UTC, preserving existing KST daily times.
  if (config.timezone && !["GMT", "UTC", "Etc/UTC"].includes(config.timezone))
    throw new Error(`cron.timezone must be UTC or GMT, got ${config.timezone}`);
  const connectionString = new URL(process.env.DATABASE_URL!);
  connectionString.pathname = `/${encodeURIComponent(config.cron_database)}`;
  const client = new Client({ connectionString: connectionString.toString() });
  const schedules = [
    {
      name: RENEWAL_SCHEDULE_NAME,
      schedule: RENEWAL_SCHEDULE,
      command: RENEWAL_SCAN_COMMAND,
    },
    ...MAINTENANCE_JOBS.map((job) => ({
      name: `naru-maintenance-${job.name}`,
      schedule: maintenanceSchedule(job),
      command: maintenanceCommand(job),
    })),
  ];
  try {
    await client.connect();
    await client.query("create extension if not exists pg_cron");
    await client.query("begin");
    try {
      for (const job of schedules)
        await client.query(
          "select cron.schedule_in_database($1, $2, $3, $4, $5)",
          [
            job.name,
            job.schedule,
            job.command,
            config.database,
            config.username,
          ],
        );
      // Reconcile only our namespace in this database, leaving other schedules
      // and every already-spawned Absurd task intact.
      await client.query(
        `select cron.unschedule(jobid) from cron.job
        where database = $1 and username = $2 and jobname like 'naru-maintenance-%'
          and not (jobname = any($3::text[]))`,
        [config.database, config.username, schedules.map((job) => job.name)],
      );
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
    await registerJobs("worker", SCHEDULED_JOBS);
    await registerJobs("cron", []); // remove obsolete scheduler heartbeat
    // One scan per current schedule slot: catches downtime without replaying
    // every missed maintenance interval or doing duplicate daily runs.
    await db.transaction().execute(async (trx) => {
      for (const job of schedules) await sql.raw(job.command).execute(trx);
    });
  } finally {
    await client.end();
  }
}
