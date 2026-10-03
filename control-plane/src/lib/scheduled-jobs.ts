import { sql } from "kysely";
import { db } from "@/lib/database";
import {
  operatorAlertsConfigured,
  sendOperatorAlert,
} from "@/lib/operator-alerts";

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
    const stalled = await sql<{
      name: string;
      process: string;
      every_seconds: number;
      last_started_at: Date;
    }>`
      UPDATE cron_jobs SET stalled_at = now()
      WHERE stalled_at IS NULL
        AND last_started_at < now() - make_interval(
          secs => every_seconds + greatest(300, round(every_seconds / 10.0))
        )
      RETURNING name, process, every_seconds, last_started_at
    `.execute(trx);
    const recovered = await sql<{ name: string; process: string }>`
      UPDATE cron_jobs SET stalled_at = NULL
      WHERE stalled_at IS NOT NULL AND last_started_at > stalled_at
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
// heartbeat. Row locks serialize checks from multiple worker replicas.
export async function checkJobFailures(): Promise<void> {
  await db.transaction().execute(async (trx) => {
    const jobs = await trx
      .selectFrom("cron_jobs")
      .selectAll()
      .where(sql<boolean>`(failed_at is not null) <> failure_notified`)
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
