import { runDueJobs } from "@/lib/payments/payment-jobs";
import { enqueueDueRenewals } from "@/lib/payments/subscription-renewals";

// Hourly from cron.ts: queues a renewal job for each plan due by the last
// 09:00 KST and not tried in the last day, and runs them
// (lib/payments/subscription-renewals). What it cannot finish, the job queue retries.
enqueueDueRenewals()
  .then(async ({ due, jobs }) => {
    await runDueJobs();
    console.log(
      `[charge-subscriptions] ${due} subscription(s) due, ${jobs.filter(Boolean).length} new renewal job(s)`,
    );
    process.exit(0);
  })
  .catch((error) => {
    console.error("[charge-subscriptions] fatal:", error);
    process.exit(1);
  });
