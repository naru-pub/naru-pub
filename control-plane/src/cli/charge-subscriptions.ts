import {
  chargeDueSubscriptions,
  renewalCutoff,
} from "@/lib/subscription-renewals";

// Hourly from cron.ts; charges what was due by the last 09:00 KST and has not
// been tried in the last day (lib/subscription-renewals).
const now = new Date();
chargeDueSubscriptions(now, { dueBy: renewalCutoff(now) })
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("[charge-subscriptions] fatal:", error);
    process.exit(1);
  });
