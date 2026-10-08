import { db } from "@/lib/database";
import { prunePageviews } from "@/lib/analytics/retention";

prunePageviews(db)
  .then((removed) =>
    console.log(
      `[pageview-cleanup] Removed ${removed} expired events/visitors`,
    ),
  )
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => db.destroy());
