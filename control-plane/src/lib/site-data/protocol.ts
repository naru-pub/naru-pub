import { DataError } from "./validation";

// The v1 wire format's own pieces, shared by the control plane's routes
// (http.ts) and the site-data Worker, which answers anonymous requests for
// sites on Durable Objects at the edge. Both must answer byte for byte alike,
// so neither keeps a copy. No Node- or Next-only imports here.

// A public read is the same bytes for everyone, and on a site with visitors it
// is the request that arrives most often by a wide margin. Letting a shared
// cache absorb a burst of them is the difference between a popular page costing
// one database round trip every few seconds and costing one per visitor.
//
// `max-age=0` keeps the browser revalidating, so a reader who reloads is not
// looking at their own stale copy; `s-maxage` is what a CDN collapses bursts
// with. The window is short because the data behind it is a guestbook or a post
// list, where seconds of lag is unremarkable and minutes would not be. The SDK
// reads a collection its own browser just wrote with `cache: "no-store"`, so
// write-then-reread flows never see the cached copy.
//
// No `stale-while-revalidate`: it would extend how long a shared cache may keep
// answering after this window, and that window is also how long a collection
// just changed from `world` to `admin` can still be served from a cache nothing
// here can purge. Ten seconds of that is worth the traffic it collapses; a
// minute of it would not be.
//
// Cache duration is private. SDK reads after a write use the fresh transport
// flag, which bypasses shared storage regardless of the configured lifetime.
export const PUBLIC_READ_CACHE = "public, max-age=0, s-maxage=10";

// Sent when an owner request renewed its token, as epoch milliseconds. An SDK
// that never reads it is not harmed: it holds an expiry no later than the true
// one and signs in again, which is what it would have done regardless.
export const OWNER_EXPIRES = "Naru-Owner-Expires";
// The same expiry as whole seconds from now, which a browser whose clock is
// wrong can still add to its own. What the SDK reads; the instant stays for
// SDK files that already read it.
export const OWNER_EXPIRES_IN = "Naru-Owner-Expires-In";

export const publicHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  // A token renews as it is used, so the SDK is told the expiry it now has.
  "Access-Control-Expose-Headers": `${OWNER_EXPIRES}, ${OWNER_EXPIRES_IN}`,
  "Access-Control-Max-Age": "600",
};

/** The headers every website response starts from, before its outcome. */
export function websiteHeaders(request: Request): Record<string, string> {
  const origin = request.headers.get("origin");
  return {
    ...publicHeaders,
    "Cache-Control": "no-store",
    Vary: "Origin, Authorization",
    ...(origin &&
    (request.headers.has("authorization") || request.method === "OPTIONS")
      ? { "Access-Control-Allow-Origin": origin }
      : {}),
  };
}

// Revisions are transport tokens. Database versions never cross the public
// boundary, and browser SDKs only store and return these strings unchanged.
export function encodeRevision(version: unknown) {
  if (!Number.isSafeInteger(version) || Number(version) < 1)
    throw new Error("Invalid stored document version.");
  return `r1.${Number(version).toString(36)}`;
}

export function decodeRevision(value: string | null) {
  if (value === null) return undefined;
  const match = /^r1\.([0-9a-z]+)$/.exec(value);
  const version = match ? Number.parseInt(match[1], 36) : NaN;
  if (!Number.isSafeInteger(version) || version < 1)
    throw new DataError(400, "Invalid revision.");
  return version;
}

/** A website's write condition from `ifRevision` / `ifAbsent`, as a version. */
export function websiteCondition(url: URL) {
  const revision = url.searchParams.get("ifRevision");
  const absent = url.searchParams.get("ifAbsent");
  if (revision !== null && absent !== null)
    throw new DataError(400, "Use one write condition.");
  return absent === "1" ? 0 : decodeRevision(revision);
}

export function publicResult(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(publicResult);
  if (value instanceof Date) return value;
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.entries(record).flatMap(([key, item]) =>
      key === "version"
        ? [["revision", encodeRevision(item)]]
        : [[key, key === "data" ? item : publicResult(item)]],
    ),
  );
}

export function batchBody(body: Record<string, unknown>) {
  if (!Array.isArray(body.operations)) return body;
  return {
    ...body,
    operations: body.operations.map((raw) => {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
      const operation = raw as Record<string, unknown>;
      const condition = operation.condition;
      if (condition === undefined) return operation;
      if (
        !condition ||
        typeof condition !== "object" ||
        Array.isArray(condition)
      )
        throw new DataError(400, "Invalid write condition.");
      const expected = condition as Record<string, unknown>;
      const keys = Object.keys(expected);
      if (keys.length !== 1)
        throw new DataError(400, "Invalid write condition.");
      if (expected.absent === true)
        return { ...operation, condition: undefined, ifVersion: 0 };
      if (typeof expected.revision === "string")
        return {
          ...operation,
          condition: undefined,
          ifVersion: decodeRevision(expected.revision),
        };
      throw new DataError(400, "Invalid write condition.");
    }),
  };
}
