import { parseFilterQuery } from "../../control-plane/src/lib/site-data/filters";
import {
  PUBLIC_READ_CACHE,
  publicResult,
  websiteCondition,
  websiteHeaders,
} from "../../control-plane/src/lib/site-data/protocol";
import {
  DataError,
  jsonBody,
  NAME,
  protocolError,
} from "../../control-plane/src/lib/site-data/validation";
import type { Outcome, Served, SiteData } from "./site";

// The public data API, /api/data/v1/<site>/..., routed here for every site.
// A visitor's request is answered at the edge from the site's object instead
// of crossing to the control plane and back. Whatever needs the control plane
// is sent on to it unchanged: requests with an owner token (sign-in scope and
// renewal live in PostgreSQL), media (`_files`), batches (owner only), and
// any request the object will not answer, such as a site whose paid status it
// has not had confirmed.
//
// The answer is the control plane's (http.ts), from the same protocol module:
// same headers, same caching, same errors.

export interface WebsiteEnv {
  SITES: DurableObjectNamespace<SiteData>;
  /** Tests only: where requests are sent on, instead of the request's own URL. */
  PASSTHROUGH_ORIGIN?: string;
}

const METHODS = ["GET", "POST", "PUT", "DELETE"];

// Sites whose monthly budget is spent, until it resets, so that refusing them
// costs this isolate a map lookup rather than the object a request.
const spent = new Map<string, { until: number; message: string }>();

/** Sends the request to the control plane, the origin behind this route. */
function passThrough(request: Request, env: WebsiteEnv) {
  if (!env.PASSTHROUGH_ORIGIN) return fetch(request);
  const url = new URL(request.url);
  return fetch(
    new Request(
      new URL(url.pathname + url.search, env.PASSTHROUGH_ORIGIN),
      request,
    ),
  );
}

export async function website(
  request: Request,
  env: WebsiteEnv,
  ctx: ExecutionContext,
  site: string,
  path: string[],
): Promise<Response> {
  const headers = websiteHeaders(request);
  if (request.method === "OPTIONS")
    return new Response(null, { status: 204, headers });
  if (
    !NAME.test(site) ||
    request.headers.has("authorization") ||
    !path.length ||
    path[0] === "_files" ||
    path[0] === "_batch" ||
    !METHODS.includes(request.method)
  )
    return passThrough(request, env);
  const refusal = spent.get(site);
  if (refusal && Date.now() < refusal.until)
    return protocolError(429, refusal.message, "RATE_LIMITED", headers);

  const url = new URL(request.url);
  const fresh = url.searchParams.get("fresh") === "1";
  const cache = (caches as unknown as { default: Cache }).default;
  if (request.method === "GET" && !fresh) {
    const hit = await cache.match(request);
    if (hit) {
      // Stored with a cacheable lifetime; sent with the public one.
      const response = new Response(hit.body, hit);
      response.headers.set("Cache-Control", PUBLIC_READ_CACHE);
      return response;
    }
  }
  // Kept whole in case the object hands the request back.
  const original = request.method === "GET" ? request : request.clone();
  try {
    const body = ["POST", "PUT"].includes(request.method)
      ? await jsonBody(request)
      : undefined;
    const stub = env.SITES.get(env.SITES.idFromName(site));
    const outcome = (await stub.serve({
      path,
      method: request.method,
      body,
      filter: parseFilterQuery(url.searchParams.get("filter")),
      includeTotal: url.searchParams.get("includeTotal") === "1",
      ifVersion: websiteCondition(url),
      sort: url.searchParams.get("sort") ?? undefined,
      after: url.searchParams.get("after") ?? undefined,
      size: url.searchParams.has("size")
        ? Number(url.searchParams.get("size"))
        : undefined,
      // Set by Cloudflare at the edge, so it can be trusted here.
      clientIp: request.headers.get("cf-connecting-ip") ?? undefined,
    })) as Outcome<Served>;
    if (!outcome.ok) {
      const { status, message, code, resetsAt } = outcome.error;
      if (resetsAt) spent.set(site, { until: resetsAt, message });
      return protocolError(status, message, code, headers);
    }
    if (outcome.value.pass) return passThrough(original, env);
    const { result, publicRead } = outcome.value;
    const cacheable = publicRead && !fresh;
    const response = Response.json(publicResult(result), {
      status: request.method === "POST" ? 201 : 200,
      headers: {
        ...headers,
        ...(cacheable ? { "Cache-Control": PUBLIC_READ_CACHE } : {}),
      },
    });
    if (cacheable && request.method === "GET") {
      // The Cache API keeps a response for its max-age, which the public
      // header sets to 0 for browsers; store it with the shared lifetime.
      const stored = response.clone();
      const copy = new Response(stored.body, stored);
      copy.headers.set("Cache-Control", "public, max-age=10");
      ctx.waitUntil(cache.put(request, copy));
    }
    return response;
  } catch (error) {
    if (error instanceof DataError)
      return protocolError(error.status, error.message, error.code, headers);
    console.error("Site database request failed", error);
    return protocolError(500, "Database request failed.", undefined, headers);
  }
}
