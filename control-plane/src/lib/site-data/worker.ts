import { DataError, type ErrorCode } from "./validation";

// The control plane's client for the site-data Worker (edge/ at
// the repository root), reached over HTTPS with a shared secret. Each call is
// one operation on one site's Durable Object.

const WORKER_TIMEOUT_MS = 10_000;

const unavailable = () =>
  new DataError(
    503,
    "The site database is unavailable. Try again shortly.",
    "UNAVAILABLE",
  );

/**
 * Calls one operation on a site's object. A refusal the object made arrives
 * as the DataError it threw; anything else the Worker answers is logged and
 * reported as unavailable.
 */
export function callSiteDataWorker<T>(
  site: string,
  operation: string,
  input: unknown,
  signal?: AbortSignal,
): Promise<T> {
  return callWorker<T>(
    `/v1/sites/${encodeURIComponent(site)}/${operation}`,
    `${operation} on ${site}`,
    input,
    signal,
  );
}

/** Calls one operation on the edge's pageview log (pageview-log.ts). */
export function callPageviewLog<T>(operation: string, input: unknown) {
  return callWorker<T>(
    `/v1/pageviews/${operation}`,
    `pageview ${operation}`,
    input,
  );
}

async function callWorker<T>(
  path: string,
  what: string,
  input: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const base = process.env.SITE_DATA_WORKER_URL;
  const secret = process.env.SITE_DATA_WORKER_SECRET;
  if (!base || !secret) {
    console.error("SITE_DATA_WORKER_URL or SITE_DATA_WORKER_SECRET is unset");
    throw unavailable();
  }
  const timeout = AbortSignal.timeout(WORKER_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(new URL(path, base), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secret}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(input),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
  } catch (error) {
    // The caller canceled: http.ts reports that itself.
    if (signal?.aborted) throw error;
    console.error(`Site database Worker unreachable for ${what}`, error);
    throw unavailable();
  }
  const body = (await response.json().catch(() => null)) as {
    value?: T;
    error?: { status: number; message: string; code?: ErrorCode };
  } | null;
  if (response.ok && body && "value" in body) return body.value as T;
  if (body?.error && body.error.status === response.status)
    throw new DataError(body.error.status, body.error.message, body.error.code);
  console.error(`Site database Worker answered ${response.status} to ${what}`);
  throw unavailable();
}

/** Erases a deleted account's site database. */
export async function eraseSiteData(site: string) {
  await callSiteDataWorker(site, "erase", {});
}
