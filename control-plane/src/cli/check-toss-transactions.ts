import "@/lib/payments/toss-calls";
import { checkTossTransactions } from "@/lib/payments/toss-transaction-check";

// Daily from cron.ts: yesterday's (KST) transactions at Toss against the
// ledger (lib/payments/toss-transaction-check).
checkTossTransactions()
  .then(({ day, transactions, problems }) => {
    console.log(
      `[check-toss-transactions] ${day}: ${transactions} Toss transaction(s), ${problems.length} mismatch(es)`,
    );
    for (const problem of problems) {
      console.log(`[check-toss-transactions] ${problem}`);
    }
    process.exit(0);
  })
  .catch((error) => {
    console.error("[check-toss-transactions] fatal:", error);
    process.exit(1);
  });
