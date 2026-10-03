import { db } from "@/lib/database";
import { pruneMaintenanceTasks } from "@/lib/maintenance/jobs";
import {
  prunePaymentLogs,
  sendPaymentEventDigest,
} from "@/lib/payments/payment-events";

// Mails pending payment events to the operators (production only) and keeps
// the event and webhook-delivery logs bounded.
async function main() {
  const digest = await sendPaymentEventDigest();
  if (digest.state === "sent") {
    console.log(
      `[payment-event-digest] mailed ${digest.events} event(s) in one digest`,
    );
  }
  const maintenance = await pruneMaintenanceTasks(db);
  if (maintenance > 0)
    console.log(
      `[payment-event-digest] pruned ${maintenance} terminal maintenance tasks`,
    );
  const pruned = await prunePaymentLogs();
  if (Object.values(pruned).some((count) => count > 0)) {
    console.log(`[payment-event-digest] pruned ${JSON.stringify(pruned)}`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("[payment-event-digest] fatal:", error);
    process.exit(1);
  });
