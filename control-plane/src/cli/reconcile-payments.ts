import { sql } from "kysely";
import { db } from "@/lib/database";
import { AccountBusyError } from "@/lib/payments/account-lock";
import { reconcilePayment } from "@/lib/payments/payment-reconciliation";

const STALE_AFTER_MS = 2 * 60 * 1000;
const BATCH_SIZE = 100;

async function main() {
  const staleBefore = new Date(Date.now() - STALE_AFTER_MS);
  const pending = await db
    .selectFrom("payments")
    .select("id")
    .where("status", "=", "pending")
    .where("created_at", "<=", staleBefore)
    // Least recently looked at first. A row that stays pending — Toss keeps
    // answering with an error, or its amount does not match — is then passed
    // over for newer ones, rather than holding a place in every batch until
    // enough of them crowd everything else out.
    .orderBy(sql`last_reconciled_at asc nulls first`)
    .orderBy("created_at", "asc")
    .limit(BATCH_SIZE)
    .execute();

  console.log(`[reconcile-payments] ${pending.length} pending payment(s)`);
  for (const payment of pending) {
    try {
      // Without waiting for the account lock: an account busy with another
      // payment operation is looked at again in five minutes.
      const result = await reconcilePayment(payment.id, { waitMs: 0 });
      console.log(
        `[reconcile-payments] payment ${payment.id}: ${result.state}`,
      );
    } catch (error) {
      if (error instanceof AccountBusyError) {
        console.log(
          `[reconcile-payments] payment ${payment.id}: account busy; next run`,
        );
        continue;
      }
      console.error(
        `[reconcile-payments] payment ${payment.id}: reconciliation failed`,
        error,
      );
    }
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("[reconcile-payments] fatal:", error);
    process.exit(1);
  });
