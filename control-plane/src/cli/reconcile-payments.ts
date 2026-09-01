import { db } from "@/lib/database";
import { reconcilePayment } from "@/lib/payment-reconciliation";

const STALE_AFTER_MS = 2 * 60 * 1000;
const BATCH_SIZE = 100;

async function main() {
  const staleBefore = new Date(Date.now() - STALE_AFTER_MS);
  const pending = await db
    .selectFrom("payments")
    .select("id")
    .where("status", "=", "pending")
    .where("created_at", "<=", staleBefore)
    .orderBy("created_at", "asc")
    .limit(BATCH_SIZE)
    .execute();

  console.log(`[reconcile-payments] ${pending.length} pending payment(s)`);
  for (const payment of pending) {
    try {
      const result = await reconcilePayment(payment.id);
      console.log(
        `[reconcile-payments] payment ${payment.id}: ${result.state}`,
      );
    } catch (error) {
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
