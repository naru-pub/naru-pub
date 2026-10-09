import {
  LOGIN_NAME_REGEX,
  RESERVED_LOGIN_NAMES,
} from "../../control-plane/src/lib/const";
import type { PageviewEvent } from "./pageview-log";

// Hosted sites, <login>.naru.pub or a custom domain (domains.ts), answered at
// the edge from the site bucket, so they stay up while the control plane is
// down. The rules are those the retired Rust proxy followed:
//
// - a path names a file under the site's prefix, `<login>/`; one without an
//   extension, or ending in `/`, names that directory's index.html;
// - HTML, JS and JSON are served from the bucket; anything else redirects to
//   the bucket's public domain;
// - an existing directory requested without its trailing slash redirects to
//   it, keeping the query;
// - a top-level navigation to an HTML page records a pageview.

export interface PagesEnv {
  /** The site bucket: each site's files under `<login>/`. */
  SITE_FILES: R2Bucket;
  PLATFORM_DOMAIN: string;
  R2_PUBLIC_DOMAIN: string;
}

/**
 * Records a navigation without holding the response: the caller keeps the
 * Worker alive until it lands (ExecutionContext.waitUntil).
 */
export type RecordPageview = (event: PageviewEvent) => void;

// Pages are revalidated on every request, so edits appear at once and every
// pageview is counted, and may be served stale for a day if the edge errs.
const SITE_CACHE_CONTROL = "public, max-age=0, stale-if-error=86400";
// Redirects are deterministic for a path, so browsers may keep them an hour.
const REDIRECT_CACHE_CONTROL = "public, max-age=3600, stale-if-error=86400";
const SERVED = ["html", "htm", "js", "json"];
const MAX_METADATA_BYTES = 2048;

/** The site a subdomain names, or null when it names none. */
export function siteOf(host: string, env: PagesEnv) {
  const name = host.replace(/\.$/, "").toLowerCase();
  const suffix = `.${env.PLATFORM_DOMAIN}`;
  if (!name.endsWith(suffix) || name === env.R2_PUBLIC_DOMAIN) return null;
  const login = name.slice(0, -suffix.length);
  if (!LOGIN_NAME_REGEX.test(login) || RESERVED_LOGIN_NAMES.has(login))
    return null;
  return login;
}

/**
 * Percent-decodes a URL path as the proxy did: `%XX` becomes that byte, any
 * other `%` stays, and a path that is not UTF-8 afterwards decodes to "".
 */
export function decodePath(path: string) {
  const bytes: number[] = [];
  for (let index = 0; index < path.length; index += 1) {
    const hex = path.slice(index + 1, index + 3);
    if (path[index] === "%" && /^[0-9a-fA-F]{2}$/.test(hex)) {
      bytes.push(parseInt(hex, 16));
      index += 2;
    } else {
      bytes.push(...new TextEncoder().encode(path[index]));
    }
  }
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      new Uint8Array(bytes),
    );
  } catch {
    return "";
  }
}

/** A decoded path, without its leading slash, to the file it names. */
export function resolvePath(path: string) {
  const last = path.split("/").at(-1) ?? path;
  const extension =
    last.includes(".") && !last.startsWith(".") && !last.endsWith(".");
  if (path === "" || path === "index.html") return "index.html";
  if (path.endsWith("/")) return `${path}index.html`;
  if (!extension) return `${path}/index.html`;
  return path;
}

/**
 * Where a directory requested without its trailing slash redirects: the
 * request's own path and query, so reserved characters keep their meaning.
 */
export function directoryRedirect(url: URL, decoded: string) {
  if (url.pathname.endsWith("/") || resolvePath(decoded) === decoded)
    return null;
  const path = url.pathname.replace(/^\/+/, "").replaceAll("\\", "%5C");
  // URL drops an empty query; the proxy kept the `?`.
  const query = url.search || (url.href.endsWith("?") ? "?" : "");
  return `/${path}/${query}`;
}

export type RequestKind = "navigation" | "frame" | "background" | "unknown";

/** Navigation intent from Fetch Metadata, as docs/design/pageview-analytics.md. */
export function classify(request: Request): RequestKind {
  if (request.method !== "GET") return "background";
  const mode = request.headers.get("sec-fetch-mode");
  const dest = request.headers.get("sec-fetch-dest");
  if (mode === "navigate" && dest === "document") return "navigation";
  if (mode === "navigate" && (dest === "iframe" || dest === "frame"))
    return "frame";
  if (mode === null || dest === null) return "unknown";
  return "background";
}

/** At most MAX_METADATA_BYTES of UTF-8, cut on a character boundary. */
export function truncate(value: string | null) {
  if (value === null) return null;
  const bytes = new TextEncoder().encode(value);
  if (bytes.length <= MAX_METADATA_BYTES) return value;
  let end = MAX_METADATA_BYTES;
  // Continuation bytes are 10xxxxxx; back up to the start of a character.
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1;
  return new TextDecoder().decode(bytes.subarray(0, end));
}

/** The path a pageview is counted under: no index.html, no trailing slash. */
export function pageviewPath(decoded: string) {
  if (decoded === "") return "/";
  let path = decoded;
  while (path.endsWith("index.html")) path = path.slice(0, -10);
  path = path.replace(/\/+$/, "");
  return `/${path}`;
}

// Bytes, not strings: a string body would gain a text/plain type the proxy
// never sent.
const text = (body: string) => new TextEncoder().encode(body);

export function notFound() {
  return new Response(text("Not Found"), {
    status: 404,
    headers: { "Cache-Control": "no-store" },
  });
}

// A 5xx, never a 404, for failures on our side, as the proxy answered.
function unavailable() {
  return new Response(text("Service Unavailable"), {
    status: 502,
    headers: { "Cache-Control": "no-store", "Retry-After": "30" },
  });
}

/** Answers a request for one of the sites `siteOf` names. */
export async function servePage(
  request: Request,
  env: PagesEnv,
  login: string,
  record: RecordPageview,
): Promise<Response> {
  const kind = classify(request);
  const timestamp = Date.now();
  const url = new URL(request.url);
  const decoded = decodePath(url.pathname.replace(/^\/+/, ""));
  const path = resolvePath(decoded);
  const extension = path.split(".").at(-1) ?? "";
  if (!SERVED.includes(extension))
    return new Response(text("Redirecting..."), {
      status: 302,
      headers: {
        Location: `https://${env.R2_PUBLIC_DOMAIN}/${login}/${path}`,
        "Cache-Control": REDIRECT_CACHE_CONTROL,
      },
    });

  let object: R2ObjectBody | null;
  try {
    object = await env.SITE_FILES.get(`${login}/${path}`);
  } catch (error) {
    console.error(`Reading ${login}/${path} failed`, error);
    return unavailable();
  }
  if (!object) return notFound();
  // Only an existing directory is canonicalized. The redirect is not a
  // pageview; the request it leads to records one.
  const location = directoryRedirect(url, decoded);
  if (location) {
    await object.body.cancel();
    return new Response(null, {
      status: 308,
      headers: { Location: location, "Cache-Control": REDIRECT_CACHE_CONTROL },
    });
  }
  if ((extension === "html" || extension === "htm") && kind === "navigation")
    record({
      login,
      timestamp,
      path: pageviewPath(decoded),
      ip: request.headers.get("cf-connecting-ip") ?? "",
      referrer: truncate(request.headers.get("referer")),
      userAgent: truncate(request.headers.get("user-agent")),
    });
  return new Response(object.body, {
    headers: {
      "Content-Type": object.httpMetadata?.contentType ?? "",
      "Cache-Control": SITE_CACHE_CONTROL,
    },
  });
}
