import aliases from "../../control-plane/sdk/aliases.json";

// The Data SDK, naru.pub/sdk/<version>/naru.js and naru.d.ts, answered at the
// edge so sites that import it keep working while the control plane is down.
// The files are the committed control-plane/public/sdk/, deployed with the
// Worker as its static assets; an alias such as /sdk/1/ names the newest
// release of its line (control-plane/sdk/aliases.json), as the control
// plane's own rewrite does.

export interface SdkEnv {
  /** control-plane/public/sdk/, so /1.0.0/naru.js is that release's module. */
  SDK_FILES: Fetcher;
}

const VERSION = /^\d+\.\d+\.\d+$/;
const CONTENT_TYPES: Record<string, string> = {
  "naru.js": "text/javascript; charset=utf-8",
  // Declarations are text an editor or a person reads.
  "naru.d.ts": "text/plain; charset=utf-8",
};

const ALIASES: Record<string, string> = aliases;

/** The asset a /sdk/ path names, such as "/1.0.0/naru.js", or null. */
export function sdkAsset(pathname: string) {
  const match = /^\/sdk\/([^/]+)\/([^/]+)$/.exec(pathname);
  if (!match || !Object.hasOwn(CONTENT_TYPES, match[2])) return null;
  const version = Object.hasOwn(ALIASES, match[1])
    ? ALIASES[match[1]]
    : match[1];
  return VERSION.test(version) ? `/${version}/${match[2]}` : null;
}

export async function serveSdk(request: Request, env: SdkEnv) {
  const url = new URL(request.url);
  const asset = sdkAsset(url.pathname);
  if (!asset) return new Response("Not found.", { status: 404 });
  if (request.method !== "GET" && request.method !== "HEAD")
    return new Response("Method not allowed.", {
      status: 405,
      headers: { Allow: "GET, HEAD" },
    });
  // The visitor's own headers, so a revalidation is answered 304.
  const found = await env.SDK_FILES.fetch(
    new Request(new URL(asset, url), {
      method: request.method,
      headers: request.headers,
    }),
  );
  if (!found.ok && found.status !== 304)
    return new Response("Not found.", { status: 404 });
  const response = new Response(found.body, found);
  response.headers.set("Content-Type", CONTENT_TYPES[asset.split("/")[2]]);
  response.headers.set("Access-Control-Allow-Origin", "*");
  response.headers.set("X-Content-Type-Options", "nosniff");
  // Browsers revalidate, so a fix reaches /sdk/1/ on the next load.
  response.headers.set("Cache-Control", "no-cache");
  return response;
}
