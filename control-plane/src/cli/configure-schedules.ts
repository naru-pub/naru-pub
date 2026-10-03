import { db } from "@/lib/database";
import { configureSchedules } from "@/lib/maintenance/schedules";

configureSchedules()
  .then(() => console.log("[configure-schedules] pg_cron schedules configured"))
  .catch((error) => {
    console.error("[configure-schedules] failed", error);
    process.exitCode = 1;
  })
  .finally(() => db.destroy());
