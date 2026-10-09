import { db } from "@/lib/database";
import { edgeConfigured, syncEdge } from "@/lib/site-data/edge";

// Keeps the edge in step with PostgreSQL for sites on Durable Objects: their
// Worker routes, and the date their database feature runs to, which the edge
// checks in place of PostgreSQL. Does nothing until the Worker and the
// Cloudflare API are configured.
async function main() {
  if (!edgeConfigured()) return;
  const { sites, failures } = await syncEdge((message) =>
    console.log(`[site-data-edge-sync] ${message}`),
  );
  console.log(
    `[site-data-edge-sync] ${sites} sites on Durable Objects` +
      (failures.length ? `, failed: ${failures.join(", ")}` : ""),
  );
  if (failures.length) process.exitCode = 1;
}

main().finally(() => db.destroy());
