import { validateRequest } from "@/lib/auth";
import { siteDataBackend } from "./backend";
import {
  DataError,
  jsonBody,
  protocolError,
  sameOrigin,
  type ErrorCode,
} from "./validation";
import { parseFilterQuery } from "./filters";
import { isIP } from "node:net";
import { executeMedia } from "./media";
import {
  batchBody,
  OWNER_EXPIRES,
  OWNER_EXPIRES_IN,
  PUBLIC_READ_CACHE,
  publicResult,
  websiteCondition,
  websiteHeaders,
} from "./protocol";

export async function dataRequest(
  request: Request,
  path: string[],
  site?: string,
) {
  const admin = site === undefined;
  // Boxed so the service can report back whether what it produced is public.
  const cacheability = { public: false };
  const headers: Record<string, string> = admin
    ? { "Cache-Control": "no-store", Vary: "Origin, Authorization" }
    : websiteHeaders(request);
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
    if (url.searchParams.has("ifRevision") && url.searchParams.has("ifAbsent"))
      throw new DataError(400, "Use one write condition.");
    const command = {
      site: site!,
      signal: request.signal,
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
        ? websiteCondition(url)
        : url.searchParams.has("ifVersion")
          ? Number(url.searchParams.get("ifVersion"))
          : undefined,
      sort: url.searchParams.get("sort") ?? undefined,
      after: url.searchParams.get("after") ?? undefined,
      size: url.searchParams.has("size")
        ? Number(url.searchParams.get("size"))
        : undefined,
    };
    const backend = await siteDataBackend(command.site);
    const result =
      path[0] === "_files"
        ? await executeMedia(command)
        : path[0] === "_batch"
          ? await backend.batch({ ...command, path: [] })
          : await backend.execute(command);
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
    let code: ErrorCode | undefined;
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
    } else if (request.signal.aborted) {
      status = 503;
      message = "Request canceled.";
      code = "UNAVAILABLE";
    } else console.error("Site database request failed", error);
    // The control panel ships with this server and reads a plain message;
    // websites get the versioned protocol's coded error.
    return admin
      ? Response.json({ error: message }, { status, headers })
      : protocolError(status, message, code, headers);
  }
}
