import { sql } from "kysely";
import { db } from "@/lib/database";
import { getUserEntitlement, PLAN_FEATURES } from "@/lib/entitlements";
import { callSiteDataWorker } from "./worker";

// The site-data Worker answers visitors at Cloudflare's edge, where the one
// check PostgreSQL makes for the control plane, that the site has the database
// feature, cannot be made. So the control plane tells each site's object when
// the feature ends and confirms it for an hour at a time; syncEdge renews that
// every few minutes for every site that has the feature. Past its confirmation
// an object answers no visitor and the control plane decides, so a revoked
// feature, or a sync that stopped, is never served from a stale date.

/** How long the edge may rely on one confirmation. */
const CONFIRMATION_MS = 60 * 60 * 1000;
/** Lapsed sites stay in the sync this long, so their usage keeps current. */
const LAPSED_DAYS = 60;

/** When the site's database feature ends, epoch ms; null when it does not. */
export async function databaseEntitledUntil(userId: string) {
  const entitlement = await getUserEntitlement(userId);
  if (
    !(PLAN_FEATURES[entitlement.plan ?? "supporter"] ?? []).includes("database")
  )
    return 0;
  if (entitlement.comp) return null;
  return entitlement.graceEndsAt?.getTime() ?? 0;
}

/** Confirms the site's paid status to its object; returns its usage. */
export async function configureEdge(site: string, ownerId: string) {
  return callSiteDataWorker<{ documents: number; bytes: number }>(
    site,
    "configure",
    {
      ownerId: String(ownerId),
      entitledUntil: await databaseEntitledUntil(ownerId),
      confirmedUntil: Date.now() + CONFIRMATION_MS,
    },
  );
}

/**
 * Renews the confirmation of every site with the database feature, and of
 * sites that lost it recently, and copies each one's usage to `users` for the
 * /admin usage page. Run by the site-data-edge-sync job.
 *
 * A site that fails is tried once more after the others: an object that
 * stalls for a moment should not fail the job, and a missed sync costs
 * nothing until its confirmation runs out an hour later. Only a site that
 * fails both times is reported.
 */
export async function syncEdge() {
  const sites = await db
    .selectFrom("users")
    .select(["id", "login_name"])
    .where("deleted_at", "is", null)
    .where((eb) =>
      eb.or([
        eb("supporter_comp", "=", true),
        eb(
          "supporter_until",
          ">",
          sql<Date>`now() - make_interval(days => ${LAPSED_DAYS})`,
        ),
      ]),
    )
    .execute();
  const sync = async (site: (typeof sites)[number]) => {
    const usage = await configureEdge(site.login_name, site.id);
    await db
      .updateTable("users")
      .set({
        site_data_document_count: usage.documents,
        site_data_bytes_used: usage.bytes,
      })
      .where("id", "=", site.id)
      .execute();
  };
  const retry: typeof sites = [];
  for (const site of sites) {
    try {
      await sync(site);
    } catch (error) {
      retry.push(site);
      console.warn(
        `Edge sync for ${site.login_name} failed; trying it again after the others`,
        error,
      );
    }
  }
  const failures: string[] = [];
  for (const site of retry) {
    try {
      await sync(site);
    } catch (error) {
      failures.push(site.login_name);
      console.error(`Edge sync failed for ${site.login_name}`, error);
    }
  }
  return { sites: sites.length, retried: retry.length, failures };
}
