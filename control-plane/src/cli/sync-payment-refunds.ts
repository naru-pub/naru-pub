import { db } from "@/lib/database";
import { reconcilePayment } from "@/lib/payment-reconciliation";

const LOOKBACK_DAYS = 400;
const BATCH_SIZE = 1000;

async function main() {
  const createdAfter = new Date(
    Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000,
  );
  const payments = await db
    .selectFrom("payments")
    .select("id")
    .where("status", "in", ["done", "partial_canceled"])
    .where("created_at", ">=", createdAfter)
    .orderBy("created_at", "desc")
    .limit(BATCH_SIZE)
    .execute();

  console.log(`[sync-payment-refunds] checking ${payments.length} payment(s)`);
  for (const payment of payments) {
    try {
      const result = await reconcilePayment(payment.id);
      if (result.state === "refunded") {
        console.log(
          `[sync-payment-refunds] payment ${payment.id}: ${result.full ? "full" : "partial"} refund ${result.amount}`,
        );
      }
    } catch (error) {
      console.error(
        `[sync-payment-refunds] payment ${payment.id}: sync failed`,
        error,
      );
    }
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("[sync-payment-refunds] fatal:", error);
    process.exit(1);
  });
