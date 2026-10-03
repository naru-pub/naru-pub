import { spawn } from "child_process";
import { resolve } from "path";
import { Client } from "pg";
import { TEMPLATE_PUBLISHED_CHANNEL } from "@/lib/board/preview";
import {
  operatorAlertsConfigured,
  sendOperatorAlert,
} from "@/lib/operator-alerts";
import { recordPaymentCronRun } from "@/lib/payments/payment-events";
import {
  checkStalledJobs,
  noteJobStarted,
  registerJobs,
} from "@/lib/scheduled-jobs";

const SCREENSHOT_INTERVAL = 15 * 60 * 1000; // 15 minutes
const SCREENSHOT_TIMEOUT = 10 * 60 * 1000; // 10 minutes
const HOME_DIR_TIMEOUT = 30 * 60 * 1000; // 30 minutes
const EXPORT_INTERVAL = 2 * 60 * 1000; // 2 minutes
const EXPORT_TIMEOUT = 30 * 60 * 1000; // 30 minutes
const SITE_UPDATE_INTERVAL = 5 * 60 * 1000; // 5 minutes
const SITE_UPDATE_TIMEOUT = 5 * 60 * 1000; // 5 minutes
const CUSTOM_DOMAIN_INTERVAL = 3 * 60 * 1000; // 3 minutes
const GITHUB_DEPLOYMENT_CLEANUP_INTERVAL = 15 * 60 * 1000; // 15 minutes
const CUSTOM_DOMAIN_TIMEOUT = 2 * 60 * 1000; // 2 minutes
const PAYMENT_INVARIANT_CHECK_TIMEOUT = 10 * 60 * 1000; // 10 minutes
const BILLING_NOTIFICATION_TIMEOUT = 5 * 60 * 1000; // 5 minutes
const PAYMENT_RECONCILIATION_INTERVAL = 5 * 60 * 1000; // 5 minutes
const PAYMENT_RECONCILIATION_TIMEOUT = 2 * 60 * 1000; // 2 minutes
const BILLING_KEY_DELETION_INTERVAL = 5 * 60 * 1000; // 5 minutes
const BILLING_KEY_DELETION_TIMEOUT = 2 * 60 * 1000; // 2 minutes
// Every minute, so a digest goes out soon after events stop arriving.
const PAYMENT_EVENT_DIGEST_INTERVAL = 60 * 1000; // 1 minute
const PAYMENT_EVENT_DIGEST_TIMEOUT = 2 * 60 * 1000; // 2 minutes
const TOSS_TRANSACTION_CHECK_TIMEOUT = 30 * 60 * 1000; // 30 minutes
// One Toss lookup per paid payment in the lookback window.
const PAYMENT_REFUND_SYNC_TIMEOUT = 60 * 60 * 1000; // 60 minutes
const EXPIRED_CUSTOM_DOMAIN_CLEANUP_TIMEOUT = 5 * 60 * 1000; // 5 minutes
const EXPIRED_GITHUB_DEPLOYMENT_CLEANUP_TIMEOUT = 5 * 60 * 1000; // 5 minutes
const MEDIA_CLEANUP_INTERVAL = 15 * 60 * 1000;
const MEDIA_CLEANUP_TIMEOUT = 5 * 60 * 1000;
const SITE_DATA_CLEANUP_INTERVAL = 30 * 60 * 1000;
const SITE_DATA_CLEANUP_TIMEOUT = 5 * 60 * 1000;

// Jobs whose last run failed. The operators hear when a job starts failing
// and when it recovers, not every run in between: a job that runs every few
// minutes would otherwise flood the channel.
const failingJobs = new Set<string>();

async function runWithTimeout(
  script: string,
  timeout: number,
  scriptArgs: string[] = [],
): ReturnType<typeof spawnScript> {
  const result = await spawnScript(script, timeout, scriptArgs);
  const name = scriptArgs.length ? `${script} ${scriptArgs.join(" ")}` : script;
  if (!result.success && !failingJobs.has(name)) {
    failingJobs.add(name);
    await alertOperators({
      title: `작업 실패: ${name}`,
      lines: [
        result.timedOut
          ? `제한 시간 ${timeout / 60_000}분을 넘겨 중단했습니다.`
          : `종료 코드 ${result.code ?? "없음"}.`,
        ...result.outputTail.trim().split("\n").slice(-8),
      ],
    });
  } else if (result.success && failingJobs.delete(name)) {
    await alertOperators({ title: `작업 복구: ${name}`, lines: [] });
  }
  return result;
}

// Best effort: an alert that cannot be sent is logged, never a job failure.
async function alertOperators(alert: { title: string; lines: string[] }) {
  if (!operatorAlertsConfigured()) return;
  try {
    await sendOperatorAlert(alert);
  } catch (error) {
    console.error("[cron] operator alert could not be sent:", error);
  }
}

function spawnScript(
  script: string,
  timeout: number,
  scriptArgs: string[] = [],
): Promise<{
  success: boolean;
  code: number | null;
  timedOut: boolean;
  outputTail: string;
}> {
  return new Promise((resolve) => {
    console.log(`[cron] Starting ${script}`);

    // In the jobs image this is dist/cli/cron.mjs and the scripts are compiled
    // beside it (scripts/build-cli.mjs). From source, tsx as a loader in this
    // same node binary, not the tsx CLI: that one is a second node process
    // which only exists to start the real one, and it is on PATH only when
    // pnpm put it there.
    const args = __filename.endsWith(".mjs")
      ? [
          ...process.execArgv,
          `${__dirname}/${script.replace(/\.tsx?$/, ".mjs")}`,
          ...scriptArgs,
        ]
      : ["--import", "tsx", `src/cli/${script}`, ...scriptArgs];
    const child = spawn(process.execPath, args, {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    // Passed through to the container's log as before, and the last of it
    // kept for the payment jobs' run records.
    let outputTail = "";
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
    let timedOut = false;

    const timer = setTimeout(() => {
      console.log(
        `[cron] ${script} timed out after ${timeout / 1000}s, killing`,
      );
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5000);
    }, timeout);

    child.on("close", (code) => {
      clearTimeout(timer);
      console.log(`[cron] ${script} exited with code ${code}`);
      resolve({ success: code === 0, code, timedOut, outputTail });
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      console.error(`[cron] ${script} error:`, err);
      resolve({ success: false, code: null, timedOut, outputTail });
    });
  });
}

async function runScreenshotUpdater() {
  await runWithTimeout("update-screenshots.tsx", SCREENSHOT_TIMEOUT);
}

// Template previews are rendered as soon as a template is published: the
// publish sends a NOTIFY, and this renders whatever is waiting. Publishes that
// arrive while a render runs are folded into one more run after it.
let templateRenderRunning = false;
let templateRenderQueued = false;

async function runTemplatePreviewRenderer() {
  if (templateRenderRunning) {
    templateRenderQueued = true;
    return;
  }
  templateRenderRunning = true;
  try {
    do {
      templateRenderQueued = false;
      await runWithTimeout("update-screenshots.tsx", SCREENSHOT_TIMEOUT, [
        "--templates",
      ]);
    } while (templateRenderQueued);
  } finally {
    templateRenderRunning = false;
  }
}

function listenForTemplatePublishes() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.log(
      "[cron] DATABASE_URL is not set; template previews wait for the 15-minute run",
    );
    return;
  }

  const connect = async () => {
    const client = new Client({ connectionString });
    let retried = false;
    const retry = (error: unknown) => {
      if (retried) return;
      retried = true;
      console.error("[cron] Template publish listener lost:", error);
      client.end().catch(() => {});
      setTimeout(connect, 30 * 1000);
    };
    client.on("error", retry);
    client.on("end", () => retry("connection ended"));
    client.on("notification", () => {
      void runTemplatePreviewRenderer();
    });
    try {
      await client.connect();
      await client.query(`LISTEN ${TEMPLATE_PUBLISHED_CHANNEL}`);
      console.log("[cron] Listening for published templates");
      // Anything published while this was disconnected.
      void runTemplatePreviewRenderer();
    } catch (error) {
      retry(error);
    }
  };

  void connect();
}

async function runHomeDirectoryUpdater() {
  await runWithTimeout("update-home-directory-sizes.ts", HOME_DIR_TIMEOUT);
}

async function runExportProcessor() {
  await runWithTimeout("process-exports.ts", EXPORT_TIMEOUT);
}

async function runSiteUpdateDispatcher() {
  await runWithTimeout("dispatch-site-updates.ts", SITE_UPDATE_TIMEOUT);
}

async function runCustomDomainRefresher() {
  await runWithTimeout("refresh-custom-domains.ts", CUSTOM_DOMAIN_TIMEOUT);
}

// A payment job is never started while its last run is still going, and each
// run is kept in payment_cron_runs. A failure alerts the operators like any
// other job's (runWithTimeout).
const paymentJobsRunning = new Set<string>();

async function runPaymentJob(script: string, timeout: number) {
  if (paymentJobsRunning.has(script)) {
    console.log(`[cron] ${script} is still running; not starting another`);
    return;
  }
  paymentJobsRunning.add(script);
  try {
    const startedAt = new Date();
    const { success, code, timedOut, outputTail } = await runWithTimeout(
      script,
      timeout,
    );
    await recordPaymentCronRun({
      script,
      startedAt,
      exitCode: code,
      timedOut,
      outputTail,
    });
  } finally {
    paymentJobsRunning.delete(script);
  }
}

async function runBillingNotifications() {
  await runPaymentJob(
    "send-billing-notifications.ts",
    BILLING_NOTIFICATION_TIMEOUT,
  );
}

async function runPaymentReconciliation() {
  await runPaymentJob("reconcile-payments.ts", PAYMENT_RECONCILIATION_TIMEOUT);
}

async function runBillingKeyDeletion() {
  await runPaymentJob(
    "delete-retired-billing-keys.ts",
    BILLING_KEY_DELETION_TIMEOUT,
  );
}

async function runTossTransactionCheck() {
  await runPaymentJob(
    "check-toss-transactions.ts",
    TOSS_TRANSACTION_CHECK_TIMEOUT,
  );
}

async function runPaymentInvariantCheck() {
  await runPaymentJob(
    "check-payment-invariants.ts",
    PAYMENT_INVARIANT_CHECK_TIMEOUT,
  );
}

async function runPaymentEventDigest() {
  await runWithTimeout(
    "send-payment-event-digest.ts",
    PAYMENT_EVENT_DIGEST_TIMEOUT,
  );
}

async function runPaymentRefundSync() {
  await runPaymentJob("sync-payment-refunds.ts", PAYMENT_REFUND_SYNC_TIMEOUT);
}

async function runExpiredCustomDomainCleanup() {
  await runWithTimeout(
    "cleanup-expired-custom-domains.ts",
    EXPIRED_CUSTOM_DOMAIN_CLEANUP_TIMEOUT,
  );
}

async function runExpiredGitHubDeploymentCleanup() {
  await runWithTimeout(
    "cleanup-expired-github-deployments.ts",
    EXPIRED_GITHUB_DEPLOYMENT_CLEANUP_TIMEOUT,
  );
}

async function runMediaCleanup() {
  await runWithTimeout("cleanup-pending-media.ts", MEDIA_CLEANUP_TIMEOUT);
}

async function runSiteDataGrantCleanup() {
  await runWithTimeout(
    "cleanup-site-data-grants.ts",
    SITE_DATA_CLEANUP_TIMEOUT,
  );
}

// Korea has no daylight saving time, so KST is always UTC+9.
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

// The jobs scheduled below, registered in cron_jobs at start so that one that
// stops starting is noticed (lib/scheduled-jobs). Each start is noted there.
const scheduled: Array<{ name: string; everySeconds: number }> = [];

function started(name: string, fn: () => Promise<void>) {
  return () => {
    void noteJobStarted(name);
    void fn();
  };
}

// Every `ms`, and once `firstAfterMs` after start when given.
function scheduleEvery(
  name: string,
  ms: number,
  fn: () => Promise<void>,
  firstAfterMs?: number,
) {
  scheduled.push({ name, everySeconds: ms / 1000 });
  const run = started(name, fn);
  setInterval(run, ms);
  if (firstAfterMs !== undefined) setTimeout(run, firstAfterMs);
}

// Daily times are Korean time, whatever zone the container runs in (UTC in
// production): 04:00 means 04:00 in Seoul, as the docs and the supporters'
// mail say.
function scheduleDaily(
  name: string,
  hour: number,
  minute: number,
  fn: () => Promise<void>,
) {
  scheduled.push({ name, everySeconds: 24 * 60 * 60 });
  const run = started(name, fn);
  const runIfTime = () => {
    const kst = new Date(Date.now() + KST_OFFSET_MS);
    if (kst.getUTCHours() === hour && kst.getUTCMinutes() === minute) {
      run();
    }
  };

  // Check every minute
  setInterval(runIfTime, 60 * 1000);

  // Also check on startup
  runIfTime();
}

// Best effort, like every alert here. CRON_HEARTBEAT_URL, when set, is pinged
// after each check: an outside service (healthchecks.io and the like) that
// expects it every minute notices what no process here can — the whole server
// down.
async function watchScheduledJobs() {
  try {
    await checkStalledJobs();
  } catch (error) {
    console.error("[cron] scheduled job check failed:", error);
  }
  const ping = process.env.CRON_HEARTBEAT_URL;
  if (ping) {
    await fetch(ping, { signal: AbortSignal.timeout(10 * 1000) }).catch(
      (error) => console.error("[cron] heartbeat ping failed:", error),
    );
  }
}

async function main() {
  console.log("[cron] Starting cron scheduler");

  // Run screenshot updater every 15 minutes
  console.log("[cron] Scheduling screenshot updater every 15 minutes");
  // and on startup after a short delay.
  scheduleEvery(
    "screenshot-updater",
    SCREENSHOT_INTERVAL,
    runScreenshotUpdater,
    10 * 1000,
  );

  listenForTemplatePublishes();

  // Run export processor every 2 minutes
  console.log("[cron] Scheduling export processor every 2 minutes");
  scheduleEvery("export-processor", EXPORT_INTERVAL, runExportProcessor);

  // Run site-update dispatcher every 5 minutes
  console.log("[cron] Scheduling site-update dispatcher every 5 minutes");
  scheduleEvery(
    "site-update-dispatcher",
    SITE_UPDATE_INTERVAL,
    runSiteUpdateDispatcher,
  );

  // Run custom-domain verification poller every 3 minutes
  console.log("[cron] Scheduling custom-domain refresher every 3 minutes");
  scheduleEvery(
    "custom-domain-refresher",
    CUSTOM_DOMAIN_INTERVAL,
    runCustomDomainRefresher,
    20 * 1000,
  );

  console.log("[cron] Scheduling payment reconciliation every 5 minutes");
  scheduleEvery(
    "payment-reconciliation",
    PAYMENT_RECONCILIATION_INTERVAL,
    runPaymentReconciliation,
    45 * 1000,
  );

  console.log("[cron] Scheduling billing key deletion every 5 minutes");
  scheduleEvery(
    "billing-key-deletion",
    BILLING_KEY_DELETION_INTERVAL,
    runBillingKeyDeletion,
    55 * 1000,
  );

  console.log("[cron] Scheduling payment event digest every minute");
  scheduleEvery(
    "payment-event-digest",
    PAYMENT_EVENT_DIGEST_INTERVAL,
    runPaymentEventDigest,
  );

  // Run expired GitHub deployment cleanup every 15 minutes
  console.log("[cron] Scheduling GitHub deployment cleanup every 15 minutes");
  scheduleEvery(
    "github-deployment-cleanup",
    GITHUB_DEPLOYMENT_CLEANUP_INTERVAL,
    runExpiredGitHubDeploymentCleanup,
    30 * 1000,
  );

  console.log("[cron] Scheduling pending media cleanup every 15 minutes");
  scheduleEvery(
    "media-cleanup",
    MEDIA_CLEANUP_INTERVAL,
    runMediaCleanup,
    40 * 1000,
  );

  console.log("[cron] Scheduling site database grant cleanup every 30 minutes");
  scheduleEvery(
    "site-data-grant-cleanup",
    SITE_DATA_CLEANUP_INTERVAL,
    runSiteDataGrantCleanup,
    50 * 1000,
  );

  // Daily jobs run at Korean times (scheduleDaily).
  console.log("[cron] Scheduling home directory updater daily at 22:00 KST");
  scheduleDaily("home-directory-updater", 22, 0, runHomeDirectoryUpdater);

  console.log("[cron] Scheduling payment refund sync daily at 04:15 KST");
  scheduleDaily("payment-refund-sync", 4, 15, runPaymentRefundSync);

  console.log("[cron] Scheduling billing notifications daily at 09:00 KST");
  scheduleDaily("billing-notifications", 9, 0, runBillingNotifications);

  console.log(
    "[cron] Scheduling expired custom-domain cleanup daily at 04:30 KST",
  );
  scheduleDaily(
    "expired-custom-domain-cleanup",
    4,
    30,
    runExpiredCustomDomainCleanup,
  );

  console.log("[cron] Scheduling Toss transaction check daily at 04:45 KST");
  scheduleDaily("toss-transaction-check", 4, 45, runTossTransactionCheck);

  console.log("[cron] Scheduling payment invariant check daily at 05:00 KST");
  scheduleDaily("payment-invariant-check", 5, 0, runPaymentInvariantCheck);

  // This process's own heartbeat, and the watch over every job's, the
  // worker's heartbeat included (lib/scheduled-jobs).
  scheduleEvery("cron", 60 * 1000, watchScheduledJobs, 30 * 1000);
  try {
    await registerJobs("cron", scheduled);
  } catch (error) {
    console.error("[cron] could not register the scheduled jobs:", error);
  }

  // Keep process alive
  process.on("SIGTERM", () => {
    console.log("[cron] Received SIGTERM, shutting down");
    process.exit(0);
  });

  process.on("SIGINT", () => {
    console.log("[cron] Received SIGINT, shutting down");
    process.exit(0);
  });
}

main();
