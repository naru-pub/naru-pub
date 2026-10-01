import { validateRequest } from "@/lib/auth";
import { db } from "@/lib/database";
import { DataError, jsonBody, protocolError, sameOrigin } from "./validation";
import { userHasFeature } from "@/lib/entitlements";
import {
  approveAuthorization,
  authorizationInput,
  prepareAuthorization,
  exchangeCode,
  updateClient,
  registerClient,
  removeClient,
  revokeClientTokens,
  revokeToken,
} from "./owner-auth";

export async function ownerAuthRequest(request: Request, action: string) {
  const crossOrigin = ["token", "revoke"].includes(action);
  const origin = request.headers.get("origin");
  const headers: Record<string, string> = {
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
    Vary: "Origin",
  };
  if (crossOrigin && origin && origin !== "null")
    Object.assign(headers, {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    });
  try {
    if (request.method === "OPTIONS" && crossOrigin)
      return new Response(null, { status: 204, headers });
    if (crossOrigin) {
      if (request.method !== "POST")
        throw new DataError(405, "Method not allowed.");
      if (action === "token") {
        // The SDK measures expiresIn on the browser's own clock, which may
        // disagree with this one; expiresAt stays for SDK files that read it.
        const { accessToken, expiresIn, expiresAt } = await exchangeCode(
          await jsonBody(request),
          origin,
        );
        return Response.json(
          { accessToken, expiresIn, expiresAt },
          { headers },
        );
      }
      const match = /^Bearer ([A-Za-z0-9_-]{43})$/i.exec(
        request.headers.get("authorization") ?? "",
      );
      if (!match) throw new DataError(401, "Invalid owner token.");
      await revokeToken(match[1], origin);
      return Response.json({ success: true }, { headers });
    }
    if (!["authorize", "prepare", "clients"].includes(action))
      throw new DataError(404, "Not found.");
    sameOrigin(request);
    const { user, session } = await validateRequest();
    if (!user || !session) throw new DataError(401, "Sign in required.");
    if (!(await userHasFeature(user.id, "database")))
      throw new DataError(403, "Database access is not enabled for this site.");
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
    // The consent page fixing the setup it found missing, on the owner's click.
    if (action === "prepare" && request.method === "POST") {
      await prepareAuthorization(user.id, authorizationInput(body));
      return Response.json({ success: true }, { headers });
    }
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
    const status = error instanceof DataError ? error.status : 500;
    const message =
      error instanceof DataError
        ? error.message
        : "Authorization request failed.";
    // What websites call is the versioned protocol; the rest is the control
    // panel's own same-origin API, which reads a plain message.
    return crossOrigin
      ? protocolError(
          status,
          message,
          error instanceof DataError ? error.code : undefined,
          headers,
        )
      : Response.json({ error: message }, { status, headers });
  }
}
