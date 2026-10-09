import { sql } from "kysely";
import { db } from "@/lib/database";
import { getUserEntitlement, PLAN_FEATURES } from "@/lib/entitlements";
import { CONFIRMATION_MS, callSiteObject } from "./client";
import { pushEdgeDomains } from "./domains";

// The edge Worker answers visitors at Cloudflare's edge, where the one check
// PostgreSQL makes for the control plane, that the site has the database
// feature, cannot be made. So the control plane tells each site's object when
// the feature ends, and syncEdge repeats it every few minutes for every site
// that has the feature or has data. Each sync confirms the date for three
// days: past that an object answers no visitor and the control plane decides,
// so a sync that stopped is never served from a stale date forever, while an
// outage of the control plane shorter than that leaves sites answering.
//
// A change takes effect at the next sync: a lapse at its exact time (the date
// is sent ahead), a refund or a removed complimentary plan within minutes.

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
  return callSiteObject<{ documents: number; bytes: number }>(
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
 * Renews the confirmation of every site with the database feature, of sites
 * that lost it recently and of sites holding data, and copies each one's
 * usage to `users` for the /admin usage page; and sends the custom domain
 * table (domains.ts). Run by the site-data-edge-sync job.
 *
 * A site that fails is tried once more after the others: an object that
 * stalls for a moment should not fail the job, and a missed sync costs
 * nothing until its confirmation runs out days later. The domain table is
 * retried the same way. Only what fails both times is reported.
 */
export async function syncEdge() {
  const sites = await db
    .selectFrom("users")
    .select(["id", "login_name"])
    .where("deleted_at", "is", null)
    .where((eb) =>
      eb.or([
        eb("supporter_comp", "=", true),
        // A site that lost the feature some other way, such as a removed
        // complimentary plan, keeps being told so while it holds data.
        eb("site_data_document_count", ">", "0"),
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
  let domains: number | null = null;
  try {
    domains = await pushEdgeDomains();
  } catch (error) {
    console.warn(
      "Sending custom domains to the edge failed; trying again after the sites",
      error,
    );
  }
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
  if (domains === null) {
    try {
      domains = await pushEdgeDomains();
    } catch (error) {
      failures.push("custom domains");
      console.error("Sending custom domains to the edge failed", error);
    }
  }
  return { sites: sites.length, retried: retry.length, failures, domains };
}
