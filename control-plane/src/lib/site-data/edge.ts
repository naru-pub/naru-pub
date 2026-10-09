import { db } from "@/lib/database";
import {
  cloudflareRequest,
  getCloudflareZoneId,
  getPlatformDomain,
} from "@/lib/customDomains";
import { getUserEntitlement, PLAN_FEATURES } from "@/lib/entitlements";
import { callSiteDataWorker, siteDataWorkerConfigured } from "./durable-object";

// Stage 2: visitors' requests for a site on a Durable Object are answered by
// the site-data Worker at Cloudflare's edge rather than by the control plane.
// Each such site gets a Worker route, naru.pub/api/data/v1/<site>/*, so sites
// still on PostgreSQL never pass through the Worker. The site's object is told
// to answer them (`edge`) and until when the site has the database feature,
// which is the one check PostgreSQL made that the edge cannot.
//
// Nothing here decides correctness. A missing route only means the control
// plane answers, as in stage 1; an object that is frozen or not configured
// hands the request back. syncEdge, every few minutes, repairs both.

type WorkerRoute = { id: string; pattern: string; script?: string };

const workerName = () => process.env.SITE_DATA_WORKER_NAME || "naru-site-data";
const routePrefix = () => `${getPlatformDomain()}/api/data/v1/`;
const routePattern = (site: string) => `${routePrefix()}${site}/*`;

export function edgeConfigured() {
  return Boolean(
    siteDataWorkerConfigured() &&
    process.env.CLOUDFLARE_ZONE_ID &&
    process.env.CLOUDFLARE_USER_API_TOKEN,
  );
}

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

/** Tells the site's object whether to answer visitors, and until when. */
export async function configureEdge(
  site: string,
  ownerId: string,
  edge: boolean,
) {
  await callSiteDataWorker(site, "configure", {
    ownerId: String(ownerId),
    edge,
    entitledUntil: await databaseEntitledUntil(ownerId),
  });
}

async function edgeRoutes(): Promise<WorkerRoute[]> {
  const routes = await cloudflareRequest<WorkerRoute[]>(
    `/zones/${getCloudflareZoneId()}/workers/routes`,
  );
  return routes.filter(
    (route) =>
      route.script === workerName() && route.pattern.startsWith(routePrefix()),
  );
}

async function addRoute(site: string) {
  await cloudflareRequest(`/zones/${getCloudflareZoneId()}/workers/routes`, {
    method: "POST",
    body: JSON.stringify({ pattern: routePattern(site), script: workerName() }),
  });
}

async function removeRoute(route: WorkerRoute) {
  await cloudflareRequest(
    `/zones/${getCloudflareZoneId()}/workers/routes/${route.id}`,
    { method: "DELETE" },
  );
}

/** Starts answering the site's visitors at the edge. */
export async function enableEdge(site: string, ownerId: string) {
  await configureEdge(site, ownerId, true);
  if (!(await edgeRoutes()).some((r) => r.pattern === routePattern(site)))
    await addRoute(site);
}

/** Stops routing the site's visitors to the Worker. */
export async function disableEdge(site: string) {
  for (const route of await edgeRoutes())
    if (route.pattern === routePattern(site)) await removeRoute(route);
}

/**
 * Makes the edge match PostgreSQL: every site on a Durable Object has a route
 * and a current paid-until date, and no other site has a route. Run by the
 * site-data-edge-sync job, which also carries a paid status that changed
 * since (a renewal, a refund) to the edge within its interval.
 */
export async function syncEdge(log: (message: string) => void = () => {}) {
  const sites = await db
    .selectFrom("users")
    .select(["id", "login_name"])
    .where("site_data_backend", "=", "durable_object")
    .where("deleted_at", "is", null)
    .execute();
  const routes = await edgeRoutes();
  const failures: string[] = [];
  for (const site of sites) {
    try {
      await configureEdge(site.login_name, site.id, true);
      if (!routes.some((r) => r.pattern === routePattern(site.login_name))) {
        await addRoute(site.login_name);
        log(`${site.login_name}: route added`);
      }
    } catch (error) {
      failures.push(site.login_name);
      console.error(`Edge sync failed for ${site.login_name}`, error);
    }
  }
  const served = new Set(sites.map((site) => routePattern(site.login_name)));
  for (const route of routes)
    if (!served.has(route.pattern)) {
      await removeRoute(route);
      log(`${route.pattern}: route removed`);
    }
  return { sites: sites.length, failures };
}
