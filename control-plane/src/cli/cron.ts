import { spawn } from "child_process";
import { resolve } from "path";

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
const SUBSCRIPTION_CHARGE_TIMEOUT = 10 * 60 * 1000; // 10 minutes
const BILLING_NOTIFICATION_TIMEOUT = 5 * 60 * 1000; // 5 minutes
const PAYMENT_RECONCILIATION_INTERVAL = 5 * 60 * 1000; // 5 minutes
const PAYMENT_RECONCILIATION_TIMEOUT = 2 * 60 * 1000; // 2 minutes
const PAYMENT_REFUND_SYNC_TIMEOUT = 5 * 60 * 1000; // 5 minutes
const EXPIRED_CUSTOM_DOMAIN_CLEANUP_TIMEOUT = 5 * 60 * 1000; // 5 minutes
const EXPIRED_GITHUB_DEPLOYMENT_CLEANUP_TIMEOUT = 5 * 60 * 1000; // 5 minutes
const MEDIA_CLEANUP_INTERVAL = 15 * 60 * 1000;
const MEDIA_CLEANUP_TIMEOUT = 5 * 60 * 1000;

function runWithTimeout(
  script: string,
  timeout: number,
): Promise<{ success: boolean; code: number | null }> {
  return new Promise((resolve) => {
    const scriptPath = `src/cli/${script}`;
    console.log(`[cron] Starting ${script}`);

    const child = spawn("tsx", [scriptPath], {
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
