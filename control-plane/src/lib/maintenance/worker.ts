import { spawn } from "node:child_process";
import { Client } from "pg";
import { Absurd } from "absurd-sdk";
import { pool } from "@/lib/database";
import { noteJobStarted, noteJobResult } from "@/lib/scheduled-jobs";
import { recordPaymentCronRun } from "@/lib/payments/payment-events";
import {
  MAINTENANCE_LOCK_SPACE,
  MAINTENANCE_QUEUE,
  MAINTENANCE_TASK,
  maintenanceJob,
  type MaintenanceName,
  type MaintenanceJob,
} from "./jobs";

export type ScriptResult = {
  code: number | null;
  timedOut: boolean;
  outputTail: string;
};

// Bounded adapters keep the existing CLI entry points isolated: they can exit
// their own process and use Chromium without terminating the durable worker.
export function runScript(
  job: MaintenanceJob,
  signal: AbortSignal,
): Promise<ScriptResult> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const args = __filename.endsWith(".mjs")
      ? [
          ...process.execArgv,
          `${__dirname}/${job.script.replace(/\.tsx?$/, ".mjs")}`,
          ...(job.args ?? []),
        ]
      : ["--import", "tsx", `src/cli/${job.script}`, ...(job.args ?? [])];
    const child = spawn(process.execPath, args, {
      cwd: process.cwd(),
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    let outputTail = "";
    let timedOut = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const keep = (chunk: Buffer) => {
      outputTail = (outputTail + chunk.toString("utf8")).slice(-4000);
    };
    child.stdout.on("data", (chunk: Buffer) => {
      process.stdout.write(chunk);
      keep(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      process.stderr.write(chunk);
      keep(chunk);
    });
    // Kill the entire process group, including Chromium, before releasing the
    // session lock. Never leave an old child executing behind a recovered task.
    const kill = (sig: NodeJS.Signals) => {
      if (!child.pid) return;
      try {
        process.kill(-child.pid, sig);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH")
          console.error(error);
      }
    };
    const stop = () => {
      kill("SIGTERM");
      killTimer ??= setTimeout(() => kill("SIGKILL"), 5000);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, job.timeout * 1000);
    signal.addEventListener("abort", stop, { once: true });
    if (signal.aborted) stop();
    const cleanup = () => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      signal.removeEventListener("abort", stop);
      kill("SIGKILL"); // descendants must not outlive a CLI that exited early
    };
    child.once("error", (error) => {
      cleanup();
      reject(error);
    });
    child.once("close", (code) => {
      cleanup();
      if (signal.aborted) reject(signal.reason);
      else resolve({ code, timedOut, outputTail });
    });
  });
}

// Session locks must use a direct PostgreSQL connection (no transaction proxy).
// Busy tasks sleep through Absurd; different schedule slots cannot overlap.
export async function executeMaintenance(
  job: MaintenanceJob,
  signal: AbortSignal,
  heartbeat: () => Promise<void>,
  run: typeof runScript = runScript,
): Promise<boolean> {
  const lock = new Client({
    connectionString: process.env.DATABASE_URL,
    connectionTimeoutMillis: 10000,
    keepAlive: true,
  });
  const abort = new AbortController();
  const shutdown = () => abort.abort(signal.reason);
  signal.addEventListener("abort", shutdown, { once: true });
  if (signal.aborted) shutdown();
  lock.on("error", (error) => abort.abort(error));
  let beat: ReturnType<typeof setInterval> | undefined;
  let heartbeatRun: Promise<void> = Promise.resolve();
  try {
    abort.signal.throwIfAborted();
    await lock.connect();
    const {
      rows: [row],
    } = await lock.query<{ locked: boolean }>(
      "select pg_try_advisory_lock($1, hashtext($2)) as locked",
      [MAINTENANCE_LOCK_SPACE, job.lock ?? job.name],
    );
    if (!row.locked) return false;
    abort.signal.throwIfAborted();
    beat = setInterval(() => {
      heartbeatRun = heartbeatRun
        .then(() => heartbeat())
        .catch((error) => abort.abort(error));
    }, 30000);
    await noteJobStarted(
      job.name === "template-preview" ? "screenshot-updater" : job.name,
    );
    const startedAt = new Date();
    const result = await run(job, abort.signal);
    if (job.payment)
      await recordPaymentCronRun({
        script: job.script,
        startedAt,
        exitCode: result.code,
        timedOut: result.timedOut,
        outputTail: result.outputTail,
      });
    const error =
      result.code !== 0 || result.timedOut
        ? new Error(
            `${job.script}: ${result.timedOut ? `timeout (${job.timeout}s)` : `exit ${result.code}`}\n${result.outputTail}`,
          )
        : null;
    await noteJobResult(
      job.name === "template-preview" ? "screenshot-updater" : job.name,
      error,
    );
    if (error) throw error;
    console.log(`[maintenance-worker] ${job.script} completed`);
    return true;
  } finally {
    clearInterval(beat);
    await heartbeatRun;
    signal.removeEventListener("abort", shutdown);
    // Disconnect releases the lock even if a script or database operation failed.
    await lock.end();
  }
}

export async function runMaintenanceWorker(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  const workflows = new Absurd({ db: pool, queueName: MAINTENANCE_QUEUE });
  workflows.registerTask<{ name: MaintenanceName }>(
    { name: MAINTENANCE_TASK },
    async (params, ctx) => {
      const job = maintenanceJob(params.name);
      while (
        !(await ctx.step("execute", () =>
          executeMaintenance(job, signal, () => ctx.heartbeat()),
        ))
      ) {
        await ctx.sleepFor("job-busy", 30);
      }
    },
  );
  const worker = await workflows.startWorker({
    workerId: `maintenance:${process.pid}`,
    claimTimeout: 120,
    concurrency: 4,
    batchSize: 1,
    pollInterval: 0.5,
    onError: (error) => console.error("[maintenance-worker] error", error),
  });
  console.log("[maintenance-worker] Started (concurrency=4)");
  try {
    await new Promise<void>((resolve) => {
      if (signal.aborted) resolve();
      else signal.addEventListener("abort", () => resolve(), { once: true });
    });
  } finally {
    await worker.close();
    console.log("[maintenance-worker] Drained");
  }
}
