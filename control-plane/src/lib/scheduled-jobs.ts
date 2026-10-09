import { sql } from "kysely";
import { db } from "@/lib/database";
import {
  operatorAlertsConfigured,
  sendOperatorAlert,
} from "@/lib/operator-alerts";

import {
  MAINTENANCE_JOBS,
  MAINTENANCE_LOCK_SPACE,
  MAINTENANCE_TASK,
} from "@/lib/maintenance/jobs";

// pg_cron produces durable tasks; workers record starts and check for missing
// schedules. Failure/recovery alert state is persisted across restarts.

export type JobProcess = "cron" | "worker";

// Past its interval, a job is given this much more before it counts as
// stalled: a tenth of the interval, at least five minutes (a deploy restarts
// the processes; a daily job's run may start a minute late).
function graceSeconds(everySeconds: number): number {
  return Math.max(5 * 60, Math.round(everySeconds / 10));
}

// The process's jobs, at its start: a new job counts from now, and a job the
// process no longer schedules is forgotten rather than reported as stalled.
export async function registerJobs(
  process: JobProcess,
  jobs: Array<{ name: string; everySeconds: number }>,
): Promise<void> {
  await db.transaction().execute(async (trx) => {
    for (const job of jobs) {
      await trx
        .insertInto("cron_jobs")
        .values({
          name: job.name,
          process,
          every_seconds: job.everySeconds,
        })
        .onConflict((oc) =>
          oc.column("name").doUpdateSet({
            process,
            every_seconds: job.everySeconds,
          }),
        )
        .execute();
    }
    await trx
      .deleteFrom("cron_jobs")
      .where("process", "=", process)
      .$if(jobs.length > 0, (qb) =>
        qb.where(
          "name",
          "not in",
          jobs.map((job) => job.name),
        ),
      )
      .execute();
  });
}

// Best effort: a job runs whether or not its start could be noted.
export async function noteJobStarted(name: string): Promise<void> {
  try {
    await db
      .updateTable("cron_jobs")
      .set({ last_started_at: sql<Date>`now()` })
      .where("name", "=", name)
      .execute();
  } catch (error) {
    console.error(`[scheduled-jobs] could not note ${name} starting:`, error);
  }
}

const KST = new Intl.DateTimeFormat("ko-KR", {
  month: "numeric",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  timeZone: "Asia/Seoul",
});

function every(seconds: number): string {
  if (seconds % 86400 === 0) return `${seconds / 86400}일마다`;
  if (seconds % 3600 === 0) return `${seconds / 3600}시간마다`;
  if (seconds % 60 === 0) return `${seconds / 60}분마다`;
  return `${seconds}초마다`;
}

// Marks the jobs that newly stalled or recovered and tells the operators, in
// one transaction: the marks are kept only once the alert is posted, so a
// failed post is tried again on the next check, and of two processes checking
// at once only one sees each change.
export async function checkStalledJobs(): Promise<{
  stalled: string[];
  recovered: string[];
}> {
  return db.transaction().execute(async (trx) => {
    // A schedule interval is not an execution deadline. Exempt only bounded,
    // live maintenance runs: a renewed Absurd lease plus the execution lock.
    // Waiting/sleeping tasks cannot suppress a missing-schedule alert, and a
    // frozen worker loses its exemption when its lease expires.
    const activeRuns = sql`
      SELECT jobs.name
      FROM jsonb_to_recordset(${JSON.stringify(MAINTENANCE_JOBS.map((job) => ({ name: job.name, timeout: job.timeout })))}::jsonb)
        AS jobs(name text, timeout integer)
      JOIN cron_jobs monitored ON monitored.name = jobs.name AND monitored.process = 'worker'
      WHERE monitored.last_started_at > now() - make_interval(secs => jobs.timeout + 5)
        AND EXISTS (
          SELECT 1 FROM absurd.t_maintenance task
          JOIN absurd.r_maintenance run ON run.run_id = task.last_attempt_run
          WHERE task.task_name = ${MAINTENANCE_TASK}
            AND task.state = 'running' AND run.state = 'running'
            AND run.claim_expires_at > now()
            AND (task.params->>'name' = jobs.name
              OR (jobs.name = 'screenshot-updater' AND task.params->>'name' = 'template-preview'))
        )
        AND EXISTS (
          SELECT 1 FROM pg_locks execution
          WHERE execution.locktype = 'advisory' AND execution.granted
            AND execution.database = (SELECT oid FROM pg_database WHERE datname = current_database())
            AND execution.classid = ${MAINTENANCE_LOCK_SPACE}::oid
            AND execution.objid = (hashtext(jobs.name)::bigint & 4294967295)::oid
            AND execution.objsubid = 2
        )
      UNION
      -- Completion is activity too: allow the next schedule its normal grace
      -- after a long run finishes, rather than immediately flagging its old start.
      SELECT monitored.name FROM cron_jobs monitored
      JOIN absurd.t_maintenance task ON task.task_name = ${MAINTENANCE_TASK}
      JOIN absurd.r_maintenance run ON run.run_id = task.last_attempt_run
      WHERE monitored.process = 'worker'
        AND task.state = 'completed' AND run.state = 'completed'
        AND run.completed_at > now() - make_interval(
          secs => monitored.every_seconds + greatest(300, round(monitored.every_seconds / 10.0))
        )
        AND (task.params->>'name' = monitored.name
          OR (monitored.name = 'screenshot-updater' AND task.params->>'name' = 'template-preview'))
    `;
    const stalled = await sql<{
      name: string;
      process: string;
      every_seconds: number;
      last_started_at: Date;
    }>`
      UPDATE cron_jobs SET stalled_at = now()
      WHERE stalled_at IS NULL
        AND name NOT IN (${activeRuns})
        AND last_started_at < now() - make_interval(
          secs => every_seconds + greatest(300, round(every_seconds / 10.0))
        )
      RETURNING name, process, every_seconds, last_started_at
    `.execute(trx);
    const recovered = await sql<{ name: string; process: string }>`
      UPDATE cron_jobs SET stalled_at = NULL
      WHERE stalled_at IS NOT NULL
        AND (last_started_at > stalled_at OR name IN (${activeRuns}))
      RETURNING name, process
    `.execute(trx);

    const result = {
      stalled: stalled.rows.map((row) => row.name),
      recovered: recovered.rows.map((row) => row.name),
    };
    if (!operatorAlertsConfigured()) return result;
    if (stalled.rows.length > 0) {
      await sendOperatorAlert({
        title: `예약 작업 멈춤: ${result.stalled.join(", ")}`,
        lines: stalled.rows.map(
          (row) =>
            `${row.name} (${row.process}, ${every(row.every_seconds)}) — 마지막 시작 ${KST.format(new Date(row.last_started_at))}, 유예 ${Math.round(graceSeconds(row.every_seconds) / 60)}분 지남`,
        ),
      });
    }
    if (recovered.rows.length > 0) {
      await sendOperatorAlert({
        title: `예약 작업 재개: ${result.recovered.join(", ")}`,
        lines: [],
      });
    }
    return result;
  });
}

export async function noteJobResult(
  name: string,
  error: Error | null,
): Promise<void> {
  await db
    .updateTable("cron_jobs")
    .set(
      error
        ? {
            failed_at: sql<Date>`coalesce(failed_at, now())`,
            failure_message: error.message.slice(-4000),
          }
        : { failed_at: null, failure_message: null },
    )
    .where("name", "=", name)
    .execute();
}

// Notification state commits only after sending, so a failed post retries next
// heartbeat. Row locks serialize checks from multiple worker replicas. A job
// with alertAfterMinutes is reported only once it has failed without a success
// for that long (failed_at is the first failure since the last success), and
// so recovers silently from shorter failures.
export async function checkJobFailures(): Promise<void> {
  const alertAfter = Object.fromEntries(
    MAINTENANCE_JOBS.flatMap((job) =>
      "alertAfterMinutes" in job ? [[job.name, job.alertAfterMinutes]] : [],
    ),
  );
  await db.transaction().execute(async (trx) => {
    const jobs = await trx
      .selectFrom("cron_jobs")
      .selectAll()
      .where((eb) =>
        eb.or([
          eb.and([
            eb("failed_at", "is", null),
            eb("failure_notified", "=", true),
          ]),
          eb.and([
            eb("failure_notified", "=", false),
            eb(
              "failed_at",
              "<=",
              sql<Date>`now() - make_interval(mins => coalesce((${JSON.stringify(alertAfter)}::jsonb ->> cron_jobs.name)::int, 0))`,
            ),
          ]),
        ]),
      )
      .forUpdate()
      .execute();
    for (const job of jobs) {
      const failed = job.failed_at !== null;
      if (operatorAlertsConfigured())
        await sendOperatorAlert({
          title: `작업 ${failed ? "실패" : "복구"}: ${job.name}`,
          lines: failed
            ? (job.failure_message ?? "").trim().split("\n").slice(-8)
            : [],
        });
      await trx
        .updateTable("cron_jobs")
        .set({ failure_notified: failed })
        .where("id", "=", job.id)
        .execute();
    }
  });
}
