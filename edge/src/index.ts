import {
  domainSite,
  invalidTable,
  storeDomains,
  type DomainsEnv,
  type DomainTable,
} from "./domains";
import { notFound, servePage, siteOf, type PagesEnv } from "./pages";
import type { PageviewLog } from "./pageview-log";
import { serveSdk, type SdkEnv } from "./sdk";
import type { SiteData } from "./site";
import type { Outcome } from "./types";
import { website, type WebsiteEnv } from "./website";

export { PageviewLog } from "./pageview-log";
export { SiteData } from "./site";

interface Env extends WebsiteEnv, PagesEnv, DomainsEnv, SdkEnv {
  PAGEVIEWS: DurableObjectNamespace<PageviewLog>;
  SITES: DurableObjectNamespace<SiteData>;
  /** Shared with the control plane, the only caller of /v1/sites. */
  EDGE_WORKER_SECRET: string;
  /** The default monthly budget of anonymous requests per site. */
  SITE_MONTHLY_REQUESTS?: string;
  /**
   * "1" opens TEST_OPERATIONS. Only the test harness sets it
   * (control-plane/scripts/with-edge-worker.sh); production never does.
   */
  TEST_OPERATIONS?: string;
}

// Four surfaces. <login>.naru.pub, or a custom domain, is a hosted site
// (pages.ts, domains.ts). Under the platform domain, /sdk/<version>/<file> is
// the Data SDK (sdk.ts) and /api/data/v1/<site>/... the public data API
// (website.ts). /v1/sites/<site>/<operation>,
// /v1/pageviews/<operation> and /v1/domains/replace are the control plane's
// own: POST with a JSON body, answered with `{ value }` or
// `{ error: { status, message, code } }` at that status. A site's object is
// named by the site, so every request for a site meets the same one.
const OPERATIONS = [
  "execute",
  "batch",
  "collections",
  "createCollections",
  "erase",
  "configure",
] as const;
// Read and replace a whole site, ids and times included: for tests to plant
// and inspect what the public operations cannot. Not found in production.
const TEST_OPERATIONS = ["export", "import"] as const;
type Operation = (typeof OPERATIONS)[number] | (typeof TEST_OPERATIONS)[number];

// Site names.
const SITE = /^[a-zA-Z0-9_-]{1,64}$/;

// A stub's methods are remote calls, so each is named rather than looked up.
function dispatch(
  stub: DurableObjectStub<SiteData>,
  operation: Operation,
  input: never,
) {
  switch (operation) {
    case "execute":
      return stub.execute(input);
    case "batch":
      return stub.batch(input);
    case "collections":
      return stub.collections(input);
    case "createCollections":
      return stub.createCollections(input);
    case "export":
      return stub.export();
    case "import":
      return stub.import(input);
    case "erase":
      return stub.erase();
    case "configure":
      return stub.configure(input);
  }
}

function failure(status: number, message: string) {
  return Response.json({ error: { status, message } }, { status });
}

async function authorized(request: Request, secret: string | undefined) {
  if (!secret) return false;
  const given = new TextEncoder().encode(
    request.headers.get("authorization") ?? "",
  );
  const expected = new TextEncoder().encode(`Bearer ${secret}`);
  return (
    given.byteLength === expected.byteLength &&
    crypto.subtle.timingSafeEqual(given, expected)
  );
}

/** The one log of every edge-served site's pageviews (pageview-log.ts). */
const pageviews = (env: Env) =>
  env.PAGEVIEWS.get(env.PAGEVIEWS.idFromName("pageviews"));

/**
 * A request for a subdomain or a custom domain: the site it names, or the one
 * the control plane listed the domain for. Any other host is not found.
 */
async function hostedSite(request: Request, env: Env, ctx: ExecutionContext) {
  const host = new URL(request.url).hostname;
  const login = host.endsWith(`.${env.PLATFORM_DOMAIN}`)
    ? siteOf(host, env)
    : await domainSite(host, env);
  if (!login) return notFound();
  return servePage(request, env, login, (event) =>
    ctx.waitUntil(
      pageviews(env)
        .record(event)
        .catch((error) =>
          // Analytics is best effort: a page is never refused over it.
          console.error(`Recording a pageview for ${login} failed`, error),
        ),
    ),
  );
}

async function pageviewOperation(
  request: Request,
  env: Env,
  operation: string,
) {
  if (request.method !== "POST") return failure(405, "Method not allowed.");
  let input: Record<string, unknown>;
  try {
    input = await request.json();
  } catch {
    return failure(400, "Expected a JSON body.");
  }
  const log = pageviews(env);
  if (operation === "drain")
    return Response.json({ value: await log.drain(input) });
  if (operation === "ack" && Number.isSafeInteger(input.through))
    return Response.json({
      value: await log.ack({ through: input.through as number }),
    });
  return failure(404, "Not found.");
}

async function replaceDomains(request: Request, env: Env) {
  if (request.method !== "POST") return failure(405, "Method not allowed.");
  let input: unknown;
  try {
    input = await request.json();
  } catch {
    return failure(400, "Expected a JSON body.");
  }
  const invalid = invalidTable(input);
  if (invalid) return failure(400, invalid);
  await storeDomains(env, input as DomainTable);
  return Response.json({ value: null });
}

/**
 * Hosts that are not a hosted site: the platform domain (its SDK and data API
 * routes),
 * this Worker's custom domain, and the address `wrangler dev` answers on.
 */
function platformHost(hostname: string, env: Env) {
  return (
    hostname === env.PLATFORM_DOMAIN ||
    hostname === `edge.${env.PLATFORM_DOMAIN}` ||
    hostname === "localhost" ||
    /^[\d.]+$|^\[/.test(hostname)
  );
}

export default {
  async fetch(request: Request, env: Env, ctx): Promise<Response> {
    const { hostname, pathname } = new URL(request.url);
    // The zone's routes send every hosted site here: *.naru.pub, and */* for
    // custom domains. Routes without a Worker keep the platform domain on the
    // control plane and the bucket's public domains on R2; this Worker's own
    // custom domain takes precedence over all of them (docs/deployment.md).
    if (!platformHost(hostname, env)) return hostedSite(request, env, ctx);
    if (pathname.startsWith("/sdk/")) return serveSdk(request, env);
    const route = /^\/api\/data\/v1\/([^/]+)(?:\/(.*))?$/.exec(pathname);
    if (route)
      return website(
        request,
        env,
        ctx,
        decodeURIComponent(route[1]),
        (route[2] ?? "")
          .split("/")
          .filter(Boolean)
          .map((part) => decodeURIComponent(part)),
      );
    if (!(await authorized(request, env.EDGE_WORKER_SECRET)))
      return failure(401, "Unauthorized.");
    if (pathname === "/v1/domains/replace") return replaceDomains(request, env);
    const pageview = /^\/v1\/pageviews\/([a-z]+)$/.exec(pathname);
    if (pageview) return pageviewOperation(request, env, pageview[1]);
    const match = /^\/v1\/sites\/([^/]+)\/([A-Za-z]+)$/.exec(pathname);
    const site = match && decodeURIComponent(match[1]);
    const operation = match?.[2] as Operation | undefined;
    const operations: readonly string[] =
      env.TEST_OPERATIONS === "1"
        ? [...OPERATIONS, ...TEST_OPERATIONS]
        : OPERATIONS;
    if (!site || !SITE.test(site) || !operations.includes(operation!))
      return failure(404, "Not found.");
    if (request.method !== "POST") return failure(405, "Method not allowed.");
    let input: unknown;
    try {
      input = await request.json();
    } catch {
      return failure(400, "Expected a JSON body.");
    }
    const stub = env.SITES.get(env.SITES.idFromName(site));
    // Each operation takes one argument object; the object validates it.
    const outcome = (await dispatch(
      stub,
      operation!,
      input as never,
    )) as Outcome<unknown>;
    return outcome.ok
      ? // JSON drops `undefined`; the caller tells success by `value`.
        Response.json({ value: outcome.value ?? null })
      : Response.json(
          { error: outcome.error },
          { status: outcome.error.status },
        );
  },
} satisfies ExportedHandler<Env>;
