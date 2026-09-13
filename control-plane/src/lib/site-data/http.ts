import { validateRequest } from "@/lib/auth";
import { executeBatch, executeData } from "./service";
import { DataError, jsonBody, sameOrigin } from "./validation";
import { parseWhereQuery } from "./filters";
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
const PUBLIC_READ_CACHE = "public, max-age=0, s-maxage=10";

const publicHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Max-Age": "600",
};

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
    let adminUserId: number | undefined;
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
    let bearer;
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
    const body = ["POST", "PUT", "PATCH"].includes(request.method)
      ? await jsonBody(request)
      : undefined;
    // A conditional write carries its expected version in the URL: DELETE has
    // no body, and intermediaries are free to drop one.
    const ifVersion = url.searchParams.get("ifVersion");
    const command = {
      site: site!,
      path: path[0] === "_files" ? path.slice(1) : path,
      method: request.method,
      adminUserId,
      bearer,
      clientIp: forwardedIp && isIP(forwardedIp) ? forwardedIp : undefined,
      body,
      where: parseWhereQuery(url.searchParams.get("where")),
      includeTotal: url.searchParams.get("includeTotal") === "1",
      cacheability,
      // The control panel's quota readout; the media service ignores it for
      // anyone but a signed-in owner.
      usage: url.searchParams.get("usage") === "1",
      ifVersion:
        ifVersion === null
          ? undefined
          : /^\d+$/.test(ifVersion)
            ? Number(ifVersion)
            : NaN,
      orderBy: url.searchParams.get("orderBy") ?? undefined,
      pageToken: url.searchParams.get("pageToken") ?? undefined,
      limit: url.searchParams.has("limit")
        ? Number(url.searchParams.get("limit"))
        : undefined,
    };
    const result =
      path[0] === "_files"
        ? await executeMedia(command)
        : path[0] === "_batch"
          ? await executeBatch({ ...command, path: [] })
          : await executeData(command);
    return Response.json(result, {
      headers: {
        ...headers,
        // Only a read the service itself vouched for as public. Anything else
        // keeps the default no-store, including every error path below.
        ...(cacheability.public ? { "Cache-Control": PUBLIC_READ_CACHE } : {}),
      },
      status: request.method === "POST" ? 201 : 200,
    });
  } catch (error) {
    // JSONB cannot represent NUL or unpaired surrogate code points.
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      ["22P05", "22021", "22P02", "22003"].includes(String(error.code))
    ) {
      return Response.json(
        { error: "Data cannot be represented as PostgreSQL JSON." },
        { status: 400, headers },
      );
    }
    if (!(error instanceof DataError))
      console.error("Site database request failed", error);
    return Response.json(
      {
        error:
          error instanceof DataError
            ? error.message
            : "Database request failed.",
        ...(error instanceof DataError && error.code
          ? { code: error.code }
          : {}),
      },
      { status: error instanceof DataError ? error.status : 500, headers },
    );
  }
}
