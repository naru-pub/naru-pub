import { db } from "@/lib/database";
import { syncEdge } from "@/lib/edge/sync";

// Renews, for every site with the database feature, the paid-status date the
// edge Worker relies on to answer visitors at the edge, copies each site's
// database usage to `users` for /admin, and sends the custom domain table.
// See lib/edge/sync.ts.
async function main() {
  const { sites, retried, failures, domains } = await syncEdge();
  console.log(
    `[site-data-edge-sync] ${sites} sites` +
      (domains !== null ? `, ${domains} custom domains` : "") +
      (retried ? `, ${retried} retried` : "") +
      (failures.length ? `, failed: ${failures.join(", ")}` : ""),
  );
  if (failures.length) process.exitCode = 1;
}

main().finally(() => db.destroy());
