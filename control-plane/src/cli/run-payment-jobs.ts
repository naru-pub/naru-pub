import { runDueJobs } from "@/lib/payment-jobs";

// Every minute from cron.ts: the payment jobs (lib/payment-jobs) that are due —
// a mail whose first send failed, a webhook's reconciliation the account was
// too busy for.
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
