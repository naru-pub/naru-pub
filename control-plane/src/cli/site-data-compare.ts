import { db } from "@/lib/database";
import { compareSite } from "@/lib/site-data/compare";

// Checks that a site still on PostgreSQL would read the same from a Durable
// Object, before it moves there:
//
//   pnpm site-data-compare <site> [<site> ...]
//
// Copies each site into a scratch object, runs the same sorted, filtered and
// paginated reads against both, and lists the queries whose results differ.
async function main() {
  const sites = process.argv.slice(2);
  if (!sites.length) {
    console.error("Usage: site-data-compare <site> [<site> ...]");
    process.exitCode = 2;
    return;
  }
  for (const site of sites) {
    const differences = await compareSite(site, (message) =>
      console.log(`[site-data-compare] ${site}: ${message}`),
    );
    for (const difference of differences)
      console.log(`[site-data-compare] ${site}: differs: ${difference}`);
    console.log(
      `[site-data-compare] ${site}: ${differences.length ? `${differences.length} differ` : "identical"}`,
    );
    if (differences.length) process.exitCode = 1;
  }
}

main()
  .catch((error) => {
    console.error(
      `[site-data-compare] ${error instanceof Error ? error.message : error}`,
    );
    process.exitCode = 1;
  })
  .finally(() => db.destroy());
