import { spawn } from "child_process";
import { resolve } from "path";
import { Client } from "pg";
import { TEMPLATE_PUBLISHED_CHANNEL } from "@/lib/board/preview";

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
// Every due subscription is charged in one run, and a billing charge alone can
// take up to 60 seconds at Toss.
const SUBSCRIPTION_CHARGE_TIMEOUT = 2 * 60 * 60 * 1000; // 2 hours
const BILLING_NOTIFICATION_TIMEOUT = 5 * 60 * 1000; // 5 minutes
const PAYMENT_RECONCILIATION_INTERVAL = 5 * 60 * 1000; // 5 minutes
const PAYMENT_RECONCILIATION_TIMEOUT = 2 * 60 * 1000; // 2 minutes
const BILLING_KEY_DELETION_INTERVAL = 5 * 60 * 1000; // 5 minutes
const BILLING_KEY_DELETION_TIMEOUT = 2 * 60 * 1000; // 2 minutes
// Every minute, so a digest goes out soon after events stop arriving.
const PAYMENT_EVENT_DIGEST_INTERVAL = 60 * 1000; // 1 minute
const PAYMENT_EVENT_DIGEST_TIMEOUT = 2 * 60 * 1000; // 2 minutes
// One Toss lookup per paid payment in the lookback window.
const PAYMENT_REFUND_SYNC_TIMEOUT = 60 * 60 * 1000; // 60 minutes
const EXPIRED_CUSTOM_DOMAIN_CLEANUP_TIMEOUT = 5 * 60 * 1000; // 5 minutes
const EXPIRED_GITHUB_DEPLOYMENT_CLEANUP_TIMEOUT = 5 * 60 * 1000; // 5 minutes
const MEDIA_CLEANUP_INTERVAL = 15 * 60 * 1000;
const MEDIA_CLEANUP_TIMEOUT = 5 * 60 * 1000;
const SITE_DATA_CLEANUP_INTERVAL = 30 * 60 * 1000;
const SITE_DATA_CLEANUP_TIMEOUT = 5 * 60 * 1000;

function runWithTimeout(
  script: string,
  timeout: number,
  scriptArgs: string[] = [],
): Promise<{ success: boolean; code: number | null }> {
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
      stdio: "inherit",
      env: process.env,
    });

    const timer = setTimeout(() => {
      console.log(
        `[cron] ${script} timed out after ${timeout / 1000}s, killing`,
      );
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5000);
    }, timeout);

    child.on("close", (code) => {
      clearTimeout(timer);
      console.log(`[cron] ${script} exited with code ${code}`);
      resolve({ success: code === 0, code });
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      console.error(`[cron] ${script} error:`, err);
      resolve({ success: false, code: null });
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

async function runSubscriptionCharger() {
  await runWithTimeout("charge-subscriptions.ts", SUBSCRIPTION_CHARGE_TIMEOUT);
}

async function runBillingNotifications() {
  await runWithTimeout(
    "send-billing-notifications.ts",
    BILLING_NOTIFICATION_TIMEOUT,
  );
}

async function runPaymentReconciliation() {
  await runWithTimeout("reconcile-payments.ts", PAYMENT_RECONCILIATION_TIMEOUT);
}

async function runBillingKeyDeletion() {
  await runWithTimeout(
    "delete-retired-billing-keys.ts",
    BILLING_KEY_DELETION_TIMEOUT,
  );
}

async function runPaymentEventDigest() {
  await runWithTimeout(
    "send-payment-event-digest.ts",
    PAYMENT_EVENT_DIGEST_TIMEOUT,
  );
}

async function runPaymentRefundSync() {
  await runWithTimeout("sync-payment-refunds.ts", PAYMENT_REFUND_SYNC_TIMEOUT);
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

function scheduleDaily(hour: number, minute: number, fn: () => Promise<void>) {
  const runIfTime = () => {
    const now = new Date();
    if (now.getHours() === hour && now.getMinutes() === minute) {
      fn();
    }
  };

  // Check every minute
  setInterval(runIfTime, 60 * 1000);

  // Also check on startup
  runIfTime();
}

async function main() {
  console.log("[cron] Starting cron scheduler");

  // Run screenshot updater every 15 minutes
  console.log("[cron] Scheduling screenshot updater every 15 minutes");
  setInterval(runScreenshotUpdater, SCREENSHOT_INTERVAL);

  // Run on startup after a short delay
  setTimeout(runScreenshotUpdater, 10 * 1000);

  listenForTemplatePublishes();

  // Run export processor every 2 minutes
  console.log("[cron] Scheduling export processor every 2 minutes");
  setInterval(runExportProcessor, EXPORT_INTERVAL);

  // Run site-update dispatcher every 5 minutes
  console.log("[cron] Scheduling site-update dispatcher every 5 minutes");
  setInterval(runSiteUpdateDispatcher, SITE_UPDATE_INTERVAL);

  // Run custom-domain verification poller every 3 minutes
  console.log("[cron] Scheduling custom-domain refresher every 3 minutes");
  setInterval(runCustomDomainRefresher, CUSTOM_DOMAIN_INTERVAL);
  setTimeout(runCustomDomainRefresher, 20 * 1000);

  console.log("[cron] Scheduling payment reconciliation every 5 minutes");
  setInterval(runPaymentReconciliation, PAYMENT_RECONCILIATION_INTERVAL);
  setTimeout(runPaymentReconciliation, 45 * 1000);

  console.log("[cron] Scheduling billing key deletion every 5 minutes");
  setInterval(runBillingKeyDeletion, BILLING_KEY_DELETION_INTERVAL);
  setTimeout(runBillingKeyDeletion, 55 * 1000);

  console.log("[cron] Scheduling payment event digest every minute");
  setInterval(runPaymentEventDigest, PAYMENT_EVENT_DIGEST_INTERVAL);

  // Run expired GitHub deployment cleanup every 15 minutes
  console.log("[cron] Scheduling GitHub deployment cleanup every 15 minutes");
  setInterval(
    runExpiredGitHubDeploymentCleanup,
    GITHUB_DEPLOYMENT_CLEANUP_INTERVAL,
  );
  setTimeout(runExpiredGitHubDeploymentCleanup, 30 * 1000);

  console.log("[cron] Scheduling pending media cleanup every 15 minutes");
  setInterval(runMediaCleanup, MEDIA_CLEANUP_INTERVAL);
  setTimeout(runMediaCleanup, 40 * 1000);

  console.log("[cron] Scheduling site database grant cleanup every 30 minutes");
  setInterval(runSiteDataGrantCleanup, SITE_DATA_CLEANUP_INTERVAL);
  setTimeout(runSiteDataGrantCleanup, 50 * 1000);

  // Run home directory updater daily at 22:00
  console.log("[cron] Scheduling home directory updater daily at 22:00");
  scheduleDaily(22, 0, runHomeDirectoryUpdater);

  // Run subscription renewal charger daily at 04:00
  console.log("[cron] Scheduling subscription charger daily at 04:00");
  scheduleDaily(4, 0, runSubscriptionCharger);

  console.log("[cron] Scheduling payment refund sync daily at 04:15");
  scheduleDaily(4, 15, runPaymentRefundSync);

  // Send renewal reminder emails daily at 09:00
  console.log("[cron] Scheduling billing notifications daily at 09:00");
  scheduleDaily(9, 0, runBillingNotifications);

  // Run expired custom-domain cleanup daily at 04:30
  console.log("[cron] Scheduling expired custom-domain cleanup daily at 04:30");
  scheduleDaily(4, 30, runExpiredCustomDomainCleanup);

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
