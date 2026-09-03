import { validateRequest } from "@/lib/auth";
import { db } from "@/lib/database";
import { DataError, jsonBody, sameOrigin } from "./validation";
import { userHasFeature } from "@/lib/entitlements";
import { noteSupporterFeatureUse } from "@/lib/feature-usage";
import {
  approveAuthorization,
  authorizationInput,
  exchangeCode,
  siteClientId,
  updateClient,
  registerClient,
  removeClient,
  revokeClientTokens,
  revokeToken,
} from "./owner-auth";

export async function ownerAuthRequest(request: Request, action: string) {
  const crossOrigin = ["discover", "token", "revoke"].includes(action);
  const origin = request.headers.get("origin");
  const headers: Record<string, string> = {
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
    Vary: "Origin",
  };
  if (crossOrigin && origin && origin !== "null")
    Object.assign(headers, {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    });
  try {
    if (request.method === "OPTIONS" && crossOrigin)
      return new Response(null, { status: 204, headers });
    if (action === "discover") {
      if (request.method !== "GET")
        throw new DataError(405, "Method not allowed.");
      const url = new URL(request.url);
      const site = url.searchParams.get("site") || "";
      const redirectUri = url.searchParams.get("redirectUri") || "";
      let callback: URL;
      try {
        callback = new URL(redirectUri);
      } catch {
        throw new DataError(400, "Valid redirectUri required.");
      }
      if (!origin || origin !== callback.origin)
        throw new DataError(
          403,
          "Redirect origin does not match.",
          "REDIRECT_ORIGIN_MISMATCH",
        );
      const registration = await db
        .selectFrom("site_data_clients as c")
        .innerJoin("users as u", "u.id", "c.user_id")
        .select(["u.id as user_id", "c.redirect_uri"])
        .where("u.login_name", "=", site)
        .where("c.redirect_uri", "=", callback.href)
        .executeTakeFirst();
      if (!registration)
        throw new DataError(
          404,
          "Administrator callback is not registered.",
          "UNREGISTERED_REDIRECT_URI",
        );
      return Response.json(
        { clientId: await siteClientId(registration.user_id) },
        { headers },
      );
    }
    if (crossOrigin) {
      if (request.method !== "POST")
        throw new DataError(405, "Method not allowed.");
      if (action === "token")
        return Response.json(
          await exchangeCode(await jsonBody(request), origin),
          { headers },
        );
      const match = /^Bearer ([A-Za-z0-9_-]{43})$/i.exec(
        request.headers.get("authorization") ?? "",
      );
      if (!match) throw new DataError(401, "Invalid owner token.");
      await revokeToken(match[1], origin);
      return Response.json({ success: true }, { headers });
    }
    if (action !== "authorize" && action !== "clients")
      throw new DataError(404, "Not found.");
    sameOrigin(request);
    const { user, session } = await validateRequest();
    if (!user || !session) throw new DataError(401, "Sign in required.");
    if (!(await userHasFeature(user.id, "database")))
      throw new DataError(403, "Database access is not enabled for this site.");
    // Registering a client or authorizing a website is the owner wiring their
    // site up to the database; listing what already exists is not.
    if (request.method !== "GET") noteSupporterFeatureUse(user.id, "database");
    if (action === "clients" && request.method === "GET") {
      const clients = await db
        .selectFrom("site_data_clients")
        .selectAll()
        .where("user_id", "=", user.id)
        .orderBy("created_at")
        .execute();
      const collections = await db
        .selectFrom("site_data_collections")
        .select(["id", "name"])
        .where("user_id", "=", user.id)
        .execute();
      return Response.json(
        {
          clientId: await siteClientId(user.id),
          clients: clients.map((c) => ({
            id: c.id,
            redirectUri: c.redirect_uri,
            tokenLifetimeSeconds: c.token_lifetime_seconds,
            collections: collections
              .filter((col) => c.collection_ids.includes(col.id))
              .map((col) => col.name),
          })),
        },
        { headers },
      );
    }
    const body = await jsonBody(request);
    if (action === "authorize" && request.method === "POST")
      return Response.json(
        await approveAuthorization(
          user.id,
          session.id,
          authorizationInput(body),
        ),
        { headers },
      );
    if (action === "clients" && request.method === "POST")
      return Response.json(
        { client: await registerClient(user.id, body) },
        { headers, status: 201 },
      );
    if (action === "clients" && ["DELETE", "PATCH"].includes(request.method)) {
      if (typeof body.id !== "string" || body.id.length > 64)
        throw new DataError(400, "Registration ID required.");
      if (request.method === "DELETE") await removeClient(user.id, body.id);
      else if (
        body.redirectUri !== undefined ||
        body.collections !== undefined ||
        body.tokenLifetimeSeconds !== undefined
      )
        await updateClient(user.id, body.id, body);
      else await revokeClientTokens(user.id, body.id);
      return Response.json({ success: true }, { headers });
    }
    throw new DataError(405, "Method not allowed.");
  } catch (error) {
    if (!(error instanceof DataError))
      console.error("Owner authorization request failed");
    return Response.json(
      {
        error:
          error instanceof DataError
            ? error.message
            : "Authorization request failed.",
        ...(error instanceof DataError && error.code
          ? { code: error.code }
          : {}),
      },
      { status: error instanceof DataError ? error.status : 500, headers },
    );
  }
}
