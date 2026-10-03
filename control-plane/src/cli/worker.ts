import { runMaintenanceWorker } from "@/lib/maintenance/worker";
import { SCHEDULED_JOBS } from "@/lib/maintenance/jobs";
import { runPaymentWorker } from "@/lib/payments/payment-jobs";
import { db } from "@/lib/database";
import { closeAccountLockPool } from "@/lib/payments/account-lock";
import { closeFederationDatabase, federation } from "@/lib/federation";
import { configureLogging } from "@/lib/logging";
import {
  checkStalledJobs,
  checkJobFailures,
  noteJobStarted,
  registerJobs,
} from "@/lib/scheduled-jobs";

// Monitoring lives with the durable workers. External heartbeat detects a
// whole-server outage; missing schedules and job failures retain DB state.
async function watchScheduledJobs() {
  await noteJobStarted("worker");
  try {
    await checkStalledJobs();
    await checkJobFailures();
  } catch (error) {
    console.error("[worker] scheduled job check failed:", error);
  }
  const ping = process.env.CRON_HEARTBEAT_URL;
  if (ping)
    await fetch(ping, { signal: AbortSignal.timeout(10000) }).catch((error) =>
      console.error("[worker] heartbeat ping failed:", error),
    );
}

async function main() {
  await configureLogging();
  console.log("[worker] Starting Fedify queue listener");
  const abort = new AbortController();

  const shutdown = (sig: string) => {
    console.log(`[worker] Received ${sig}, shutting down`);
    abort.abort();
  };
  const shutdownTerm = () => shutdown("SIGTERM");
  const shutdownInt = () => shutdown("SIGINT");
  process.on("SIGTERM", shutdownTerm);
  process.on("SIGINT", shutdownInt);

  try {
    await registerJobs("worker", SCHEDULED_JOBS);
    await registerJobs("cron", []);
  } catch (error) {
    console.error("[worker] could not register its heartbeat:", error);
  }
  const heartbeatRuns = new Set<Promise<void>>();
  const watch = setInterval(() => {
    if (abort.signal.aborted) return;
    const run = watchScheduledJobs().catch((error) =>
      console.error("[worker] heartbeat failed", error),
    );
    heartbeatRuns.add(run);
    void run.finally(() => heartbeatRuns.delete(run));
  }, 60 * 1000);
  abort.signal.addEventListener("abort", () => clearInterval(watch));

  try {
    // If either listener exits, drain the other before closing their shared DB.
    const listeners = await Promise.allSettled([
      federation
        .startQueue(undefined, { signal: abort.signal })
        .finally(() => abort.abort()),
      runPaymentWorker(abort.signal).finally(() => abort.abort()),
      runMaintenanceWorker(abort.signal).finally(() => abort.abort()),
    ]);
    for (const result of listeners)
      if (result.status === "rejected") throw result.reason;
    console.log("[worker] Queue listeners exited");
  } finally {
    clearInterval(watch);
    await Promise.allSettled(heartbeatRuns);
    const closed = await Promise.allSettled([
      closeFederationDatabase(),
      closeAccountLockPool(),
      db.destroy(),
    ]);
    for (const result of closed)
      if (result.status === "rejected") throw result.reason;
    process.off("SIGTERM", shutdownTerm);
    process.off("SIGINT", shutdownInt);
    console.log("[worker] Database connections closed");
  }
}

main().catch((err) => {
  console.error("[worker] fatal", err);
  process.exit(1);
});
