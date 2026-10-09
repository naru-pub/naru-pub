import { db } from "@/lib/database";

// Authorization codes and access tokens were only ever swept
// opportunistically, by the next request that happened to touch the same
// owner. A site that is signed into once and then left alone keeps its
// expired rows forever. None of that is load-bearing, so a periodic sweep is
// the whole fix. (Public-write rate limits are counted in each site's Durable
// Object, which drops its old buckets itself.)
async function main() {
  const expiredCodes = await db
    .deleteFrom("site_data_auth_codes")
    .where("expires_at", "<=", new Date())
    .executeTakeFirst();
  const expiredTokens = await db
    .deleteFrom("site_data_access_tokens")
    .where("expires_at", "<=", new Date())
    .executeTakeFirst();
  const rows = (deleted: { numDeletedRows: bigint } | undefined) =>
    Number(deleted?.numDeletedRows ?? 0);
  console.log(
    `[site-data-cleanup] Removed ${rows(expiredCodes)} codes, ` +
      `${rows(expiredTokens)} tokens`,
  );
}

main().finally(() => db.destroy());
