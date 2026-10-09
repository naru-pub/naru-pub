import { db } from "@/lib/database";
import { drainEdgePageviews } from "@/lib/analytics/edge-pageviews";

// Takes the pageviews the edge recorded for the hosted sites it serves into
// PostgreSQL. See lib/analytics/edge-pageviews.ts.
//
// Fails, which alerts the operator, while events wait longer than this: the
// drain is not keeping up, so pageview counts are falling behind.
const BEHIND_MS = 30 * 60 * 1000;

async function main() {
  const { stored, skipped, waitingSince } = await drainEdgePageviews(db);
  console.log(
    `[edge-pageview-drain] ${stored} stored` +
      (skipped ? `, ${skipped} skipped` : ""),
  );
  if (waitingSince !== null && Date.now() - waitingSince > BEHIND_MS) {
    console.error(
      `[edge-pageview-drain] behind: the oldest waiting pageview is from ${new Date(waitingSince).toISOString()}`,
    );
    process.exitCode = 1;
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => db.destroy());
