import { db } from "@/lib/database";
import { closeAccountLockPool } from "@/lib/payments/account-lock";
import { closeFederationDatabase, federation } from "@/lib/federation";
import { configureLogging } from "@/lib/logging";
import {
  checkStalledJobs,
  noteJobStarted,
  registerJobs,
} from "@/lib/scheduled-jobs";

// The worker's heartbeat, and a watch over the cron's jobs and heartbeat: if
// the cron process dies, this one tells the operators (lib/scheduled-jobs).
async function watchScheduledJobs() {
  await noteJobStarted("worker");
  try {
    await checkStalledJobs();
  } catch (error) {
    console.error("[worker] scheduled job check failed:", error);
  }
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
    await registerJobs("worker", [{ name: "worker", everySeconds: 60 }]);
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
    await federation.startQueue(undefined, { signal: abort.signal });
    console.log("[worker] Queue listener exited");
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
