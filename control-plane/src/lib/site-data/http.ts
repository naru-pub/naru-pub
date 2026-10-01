import { validateRequest } from "@/lib/auth";
import { executeBatch, executeData } from "./service";
import { DataError, jsonBody, protocolError, sameOrigin } from "./validation";
import { parseFilterQuery } from "./filters";
import { isIP } from "node:net";
import { executeMedia } from "./media";

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
const PUBLIC_READ_CACHE = "public, max-age=0, s-maxage=10";

// Sent when an owner request renewed its token, as epoch milliseconds. An SDK
// that never reads it is not harmed: it holds an expiry no later than the true
// one and signs in again, which is what it would have done regardless.
const OWNER_EXPIRES = "Naru-Owner-Expires";
// The same expiry as whole seconds from now, which a browser whose clock is
// wrong can still add to its own. What the SDK reads; the instant stays for
// SDK files that already read it.
const OWNER_EXPIRES_IN = "Naru-Owner-Expires-In";

const publicHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  // A token renews as it is used, so the SDK is told the expiry it now has.
  "Access-Control-Expose-Headers": `${OWNER_EXPIRES}, ${OWNER_EXPIRES_IN}`,
  "Access-Control-Max-Age": "600",
};

// Revisions are transport tokens. Database versions never cross the public
// boundary, and browser SDKs only store and return these strings unchanged.
function encodeRevision(version: unknown) {
  if (!Number.isSafeInteger(version) || Number(version) < 1)
    throw new Error("Invalid stored document version.");
  return `r1.${Number(version).toString(36)}`;
}

function decodeRevision(value: string | null) {
  if (value === null) return undefined;
  const match = /^r1\.([0-9a-z]+)$/.exec(value);
  const version = match ? Number.parseInt(match[1], 36) : NaN;
  if (!Number.isSafeInteger(version) || version < 1)
    throw new DataError(400, "Invalid revision.");
  return version;
}

function publicResult(value: unknown): unknown {
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

function batchBody(body: Record<string, unknown>) {
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

export async function dataRequest(
  request: Request,
  path: string[],
  site?: string,
) {
  const admin = site === undefined;
  // Boxed so the service can report back whether what it produced is public.
  const cacheability = { public: false };
  const headers: Record<string, string> = {
    ...(admin ? {} : publicHeaders),
    "Cache-Control": "no-store",
    Vary: "Origin, Authorization",
    ...(!admin &&
    request.headers.get("origin") &&
    (request.headers.has("authorization") || request.method === "OPTIONS")
      ? { "Access-Control-Allow-Origin": request.headers.get("origin")! }
      : {}),
  };
  if (request.method === "OPTIONS")
    return new Response(null, { status: 204, headers });
  try {
    let adminUserId: string | undefined;
    if (admin) {
      // Never elevate cross-origin requests using ambient owner cookies.
      sameOrigin(request);
      const { user } = await validateRequest();
      if (!user) throw new DataError(401, "Sign in required.");
      adminUserId = user.id;
      site = user.loginName;
    }
    const url = new URL(request.url);
    const authorization = request.headers.get("authorization");
    // The service fills in expiresAt only when it renews the token behind it.
    let bearer:
      | { token: string; origin: string | null; expiresAt?: number }
      | undefined;
    if (!admin && authorization !== null) {
      const match = /^Bearer ([A-Za-z0-9_-]{43})$/i.exec(authorization);
      if (!match) throw new DataError(401, "Invalid owner token.");
      bearer = { token: match[1], origin: request.headers.get("origin") };
    }
    // Only enable behind a proxy that replaces this header and blocks direct ingress.
    const forwardedIp =
      process.env.SITE_DATA_TRUST_CLOUDFLARE_IP === "1"
        ? request.headers.get("cf-connecting-ip")
        : null;
    // PATCH only reaches here from the control panel, to change a collection's
    // permissions; the public route does not export it.
    let body = ["POST", "PUT", "PATCH"].includes(request.method)
      ? await jsonBody(request)
      : undefined;
    if (!admin && path[0] === "_batch" && body) body = batchBody(body);
    const revision = url.searchParams.get("ifRevision");
    const absent = url.searchParams.get("ifAbsent");
    if (revision !== null && absent !== null)
      throw new DataError(400, "Use one write condition.");
    const command = {
      site: site!,
      path: path[0] === "_files" ? path.slice(1) : path,
      method: request.method,
      adminUserId,
      bearer,
      clientIp: forwardedIp && isIP(forwardedIp) ? forwardedIp : undefined,
      body,
      filter: parseFilterQuery(url.searchParams.get("filter")),
      includeTotal: url.searchParams.get("includeTotal") === "1",
      cacheability,
      // The control panel's quota readout; the media service ignores it for
      // anyone but a signed-in owner.
      usage: url.searchParams.get("usage") === "1",
      ifVersion: !admin
        ? absent === "1"
          ? 0
          : decodeRevision(revision)
        : url.searchParams.has("ifVersion")
          ? Number(url.searchParams.get("ifVersion"))
          : undefined,
      sort: url.searchParams.get("sort") ?? undefined,
      after: url.searchParams.get("after") ?? undefined,
      size: url.searchParams.has("size")
        ? Number(url.searchParams.get("size"))
        : undefined,
    };
    const result =
      path[0] === "_files"
        ? await executeMedia(command)
        : path[0] === "_batch"
          ? await executeBatch({ ...command, path: [] })
          : await executeData(command);
    return Response.json(admin ? result : publicResult(result), {
      headers: {
        ...headers,
        ...(bearer?.expiresAt
          ? {
              [OWNER_EXPIRES]: String(bearer.expiresAt),
              [OWNER_EXPIRES_IN]: String(
                Math.max(0, Math.floor((bearer.expiresAt - Date.now()) / 1000)),
              ),
            }
          : {}),
        // Only a read the service itself vouched for as public. Anything else
        // keeps the default no-store, including every error path below.
        ...(cacheability.public && url.searchParams.get("fresh") !== "1"
          ? { "Cache-Control": PUBLIC_READ_CACHE }
          : {}),
      },
      status: request.method === "POST" ? 201 : 200,
    });
  } catch (error) {
    let status = 500;
    let message = "Database request failed.";
    let code;
    // JSONB cannot represent NUL or unpaired surrogate code points.
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      ["22P05", "22021", "22P02", "22003"].includes(String(error.code))
    ) {
      status = 400;
      message = "Data contains unsupported characters or numbers.";
    } else if (error instanceof DataError) {
      ({ status, message, code } = error);
    } else console.error("Site database request failed", error);
    // The control panel ships with this server and reads a plain message;
    // websites get the versioned protocol's coded error.
    return admin
      ? Response.json({ error: message }, { status, headers })
      : protocolError(status, message, code, headers);
  }
}
