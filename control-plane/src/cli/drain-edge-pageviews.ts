import { db } from "@/lib/database";
import { drainEdgePageviews } from "@/lib/analytics/edge-pageviews";

// Takes the pageviews the edge recorded for the hosted sites it serves into
// PostgreSQL. See lib/analytics/edge-pageviews.ts.
async function main() {
  const { stored, skipped } = await drainEdgePageviews(db);
  console.log(
    `[edge-pageview-drain] ${stored} stored` +
      (skipped ? `, ${skipped} skipped` : ""),
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => db.destroy());
