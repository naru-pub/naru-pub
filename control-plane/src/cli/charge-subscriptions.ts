import { enqueueDueRenewals } from "@/lib/payments/subscription-renewals";

// Manual producer for operator use; pg_cron normally enqueues the scan task: queues a renewal job for each plan due by the last
// 09:00 KST and not tried in the last day. The continuous worker executes
// them; the producer never drains the queue.
enqueueDueRenewals()
  .then(({ due, jobs }) => {
    console.log(
      `[charge-subscriptions] ${due} subscription(s) due, ${jobs.filter(Boolean).length} new renewal job(s)`,
    );
    process.exit(0);
  })
  .catch((error) => {
    console.error("[charge-subscriptions] fatal:", error);
    process.exit(1);
  });
