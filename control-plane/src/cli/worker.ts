import { federation } from "@/lib/federation";
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
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  try {
    await registerJobs("worker", [{ name: "worker", everySeconds: 60 }]);
  } catch (error) {
    console.error("[worker] could not register its heartbeat:", error);
  }
  const watch = setInterval(watchScheduledJobs, 60 * 1000);
  abort.signal.addEventListener("abort", () => clearInterval(watch));

  await federation.startQueue(undefined, { signal: abort.signal });
  console.log("[worker] Queue listener exited");
}

main().catch((err) => {
  console.error("[worker] fatal", err);
  process.exit(1);
});
