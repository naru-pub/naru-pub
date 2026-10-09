import { db } from "@/lib/database";
import { syncEdge } from "@/lib/site-data/edge";

// Renews, for every site with the database feature, the paid-status date the
// site-data Worker relies on to answer visitors at the edge, and copies each
// site's database usage to `users` for /admin. See lib/site-data/edge.ts.
async function main() {
  const { sites, retried, failures } = await syncEdge();
  console.log(
    `[site-data-edge-sync] ${sites} sites` +
      (retried ? `, ${retried} retried` : "") +
      (failures.length ? `, failed: ${failures.join(", ")}` : ""),
  );
  if (failures.length) process.exitCode = 1;
}

main().finally(() => db.destroy());
