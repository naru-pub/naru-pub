import { syncPaymentRefunds } from "@/lib/refund-sync";

// Stops a little before the cron's own timeout kills it, so a long run ends
// cleanly and the next one starts with what this one did not reach.
const BUDGET_MS = 50 * 60 * 1000;

syncPaymentRefunds({ budgetMs: BUDGET_MS })
  .then((result) => {
    console.log(
      `[sync-payment-refunds] checked ${result.checked}, refunded ${result.refunded}, failed ${result.failed}${result.incomplete ? " (time budget spent; the rest stay due)" : ""}`,
    );
    process.exit(0);
  })
  .catch((error) => {
    console.error("[sync-payment-refunds] fatal:", error);
    process.exit(1);
  });
