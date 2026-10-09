import { db } from "@/lib/database";
import { moveSite } from "@/lib/site-data/move";

// Moves one site's database between PostgreSQL and its Durable Object:
//
//   pnpm site-data-move <site> durable_object
//   pnpm site-data-move <site> postgres
//
// The site's writes are refused for the seconds the copy takes, and reads
// keep working. A copy that does not match puts the site back where it was.
// Run site-data-compare on a site before its first move.
async function main() {
  const [site, to] = process.argv.slice(2);
  if (!site || (to !== "durable_object" && to !== "postgres")) {
    console.error("Usage: site-data-move <site> durable_object|postgres");
    process.exitCode = 2;
    return;
  }
  const started = Date.now();
  await moveSite(site, to, (message) =>
    console.log(`[site-data-move] ${site}: ${message}`),
  );
  console.log(
    `[site-data-move] ${site} is on ${to} (${Date.now() - started} ms)`,
  );
}

main()
  .catch((error) => {
    console.error(
      `[site-data-move] ${error instanceof Error ? error.message : error}`,
    );
    process.exitCode = 1;
  })
  .finally(() => db.destroy());
