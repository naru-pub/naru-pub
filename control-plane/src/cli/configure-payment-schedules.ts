import { db } from "@/lib/database";
import { configureRenewalSchedule } from "@/lib/payments/renewal-schedule";

configureRenewalSchedule()
  .then(() =>
    console.log(
      "[configure-payment-schedules] pg_cron renewal schedule configured",
    ),
  )
  .catch((error) => {
    console.error("[configure-payment-schedules] failed", error);
    process.exitCode = 1;
  })
  .finally(() => db.destroy());
