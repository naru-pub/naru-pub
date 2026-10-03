import { runDueJobs } from "@/lib/payments/payment-jobs";

// Every minute from cron.ts: drain an Absurd batch of notifications, renewals,
// refund recovery and webhook reconciliation. Absurd owns claims and retries.
runDueJobs()
  .then(({ done, retried, failed }) => {
    if (done + retried + failed > 0) {
      console.log(
        `[run-payment-jobs] done ${done}, retried ${retried}, failed ${failed}`,
      );
    }
    process.exit(0);
  })
  .catch((error) => {
    console.error("[run-payment-jobs] fatal:", error);
    process.exit(1);
  });
