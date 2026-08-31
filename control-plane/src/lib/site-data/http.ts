import { validateRequest } from "@/lib/auth";
import { executeData } from "./service";
import { DataError, jsonBody } from "./validation";

const publicHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
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
  };
  if (request.method === "OPTIONS")
    return new Response(null, { status: 204, headers });
  try {
    let adminUserId: number | undefined;
    if (admin) {
      // Never elevate cross-origin requests using ambient owner cookies.
      const origin = request.headers.get("origin");
      if (
        (origin && origin !== new URL(request.url).origin) ||
        (!origin && request.method !== "GET") ||
        request.headers.get("sec-fetch-site") === "cross-site"
      ) {
        throw new DataError(403, "Same-origin admin request required.");
      }
      const { user } = await validateRequest();
      if (!user) throw new DataError(401, "Sign in required.");
      adminUserId = user.id;
      site = user.loginName;
    }
    const url = new URL(request.url);
    const body = ["POST", "PUT", "PATCH"].includes(request.method)
      ? await jsonBody(request)
      : undefined;
    const result = await executeData({
      site: site!,
      path,
      method: request.method,
      adminUserId,
      body,
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
