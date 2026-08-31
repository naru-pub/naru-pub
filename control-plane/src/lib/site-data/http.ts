import { validateRequest } from "@/lib/auth";
import { executeData } from "./service";
import { DataError, jsonBody, sameOrigin } from "./validation";
import { isIP } from "node:net";

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
  const headers = {
    ...(admin ? {} : publicHeaders),
    "Cache-Control": "no-store",
    Vary: "Origin",
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
    const body = ["POST", "PUT", "PATCH"].includes(request.method)
      ? await jsonBody(request)
      : undefined;
    const result = await executeData({
      site: site!,
      path,
      method: request.method,
      adminUserId,
      bearer,
      clientIp: forwardedIp && isIP(forwardedIp) ? forwardedIp : undefined,
      body,
      orderBy: url.searchParams.get("orderBy") ?? undefined,
      direction: url.searchParams.get("direction") ?? undefined,
      after: url.searchParams.get("after") ?? undefined,
      limit: url.searchParams.has("limit")
        ? Number(url.searchParams.get("limit"))
        : undefined,
    });
    return Response.json(result, {
      headers,
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
      },
      { status: error instanceof DataError ? error.status : 500, headers },
    );
  }
}
