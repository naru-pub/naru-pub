import { createHash, randomBytes, randomUUID } from "node:crypto";
import { Kysely, sql } from "kysely";
import type { DB } from "@/lib/db";
import { db } from "@/lib/database";
import { DataError, name } from "./validation";

export const TOKEN_SECONDS = 24 * 60 * 60;
const CODE_SECONDS = 60;
export const digest = (value: string) =>
  createHash("sha256").update(value).digest("base64url");
const secret = () => randomBytes(32).toString("base64url");
const denied = () =>
  new DataError(401, "Owner authorization is invalid, expired or revoked.");

function text(value: unknown, max = 2048): string {
  if (typeof value !== "string" || !value || value.length > max)
    throw new DataError(400, "Invalid authorization request.");
  return value;
}
export function collectionNames(value: unknown): string[] {
  if (!Array.isArray(value) || !value.length || value.length > 100)
    throw new DataError(400, "Choose 1–100 collections.");
  const names = value.map(name);
  if (new Set(names).size !== names.length)
    throw new DataError(400, "Duplicate collections.");
  return names;
}
export function callbackUrl(value: unknown): URL {
  let url: URL;
  try {
    url = new URL(text(value));
  } catch {
    throw new DataError(400, "Invalid callback URL.");
  }
  if (
    url.username ||
    url.password ||
    url.hash ||
    url.search ||
    !(
      url.protocol === "https:" ||
      (process.env.NODE_ENV !== "production" && url.protocol === "http:")
    )
  ) {
    throw new DataError(
      400,
      "Use an HTTPS callback without credentials, query or fragment.",
    );
  }
  return url;
}

// Rechecked at registration, approval, exchange and every authenticated data call.
// Removing or de-verifying a custom domain therefore invalidates its access.
async function assertSiteOrigin(
  tx: Kysely<DB>,
  userId: number,
  redirectUri: string,
) {
  const owner = await tx
    .selectFrom("users")
    .select("login_name")
    .where("id", "=", userId)
    .executeTakeFirst();
  if (!owner) throw denied();
  const callback = callbackUrl(redirectUri);
  const domain = process.env.NEXT_PUBLIC_DOMAIN || "naru.pub";
  const primary = new URL(
    `${process.env.NODE_ENV === "production" ? "https" : "http"}://${owner.login_name}.${domain}`,
  );
  if (callback.origin === primary.origin) return;
  if (
    process.env.NODE_ENV !== "production" &&
    ["localhost", "127.0.0.1", "[::1]"].includes(callback.hostname)
  )
    return;
  const custom = await tx
    .selectFrom("custom_domains")
    .select("id")
    .where("user_id", "=", userId)
    .where("hostname", "=", callback.hostname)
    .where("verified_at", "is not", null)
    .where("cloudflare_status", "=", "active")
    .where("ssl_status", "=", "active")
    .executeTakeFirst();
  if (!custom || callback.protocol !== "https:" || callback.port)
    throw new DataError(
      403,
      "Callback must belong to your site or an active verified custom domain.",
    );
}

async function lockOwner(tx: Kysely<DB>, userId: number) {
  await tx
    .selectFrom("users")
    .select("id")
    .where("id", "=", userId)
    .forUpdate()
    .executeTakeFirstOrThrow();
}
async function scope(tx: Kysely<DB>, userId: number, names: string[]) {
  const rows = await tx
    .selectFrom("site_data_collections")
    .select(["id", "name"])
    .where("user_id", "=", userId)
    .where("name", "in", names)
    .execute();
  if (rows.length !== names.length)
    throw new DataError(400, "Unknown collection.");
  return rows;
}

// Persist independently of callback registrations, so removing the last page does
// not change the website's public identifier. The unique owner key handles races.
export async function siteClientId(userId: number, tx: Kysely<DB> = db) {
  await tx
    .insertInto("site_data_site_clients")
    .values({ user_id: userId, id: randomUUID() })
    .onConflict((oc) => oc.column("user_id").doNothing())
    .execute();
  return (
    await tx
      .selectFrom("site_data_site_clients")
      .select("id")
      .where("user_id", "=", userId)
      .executeTakeFirstOrThrow()
  ).id;
}
async function clearClientGrants(tx: Kysely<DB>, id: string) {
  await tx
    .deleteFrom("site_data_access_tokens")
    .where("client_id", "=", id)
    .execute();
  await tx
    .deleteFrom("site_data_auth_codes")
    .where("client_id", "=", id)
    .execute();
}
export async function updateClient(
  userId: number,
  id: string,
  body: Record<string, unknown>,
) {
  const redirectUri = callbackUrl(body.redirectUri).href;
  const names = collectionNames(body.collections);
  return db.transaction().execute(async (tx) => {
    await lockOwner(tx, userId);
    const current = await tx
      .selectFrom("site_data_clients")
      .select("id")
      .where("id", "=", id)
      .where("user_id", "=", userId)
      .executeTakeFirst();
    if (!current) throw new DataError(404, "Registration not found.");
    await assertSiteOrigin(tx, userId, redirectUri);
    const duplicate = await tx
      .selectFrom("site_data_clients")
      .select("id")
      .where("user_id", "=", userId)
      .where("redirect_uri", "=", redirectUri)
      .where("id", "!=", id)
      .executeTakeFirst();
    if (duplicate) throw new DataError(409, "Callback already registered.");
    const collections = await scope(tx, userId, names);
    await clearClientGrants(tx, id);
    await tx
      .updateTable("site_data_clients")
      .set({
        redirect_uri: redirectUri,
        collection_ids: collections.map((c) => c.id),
      })
      .where("id", "=", id)
      .execute();
    return { clientId: await siteClientId(userId, tx) };
  });
}

export async function registerClient(
  userId: number,
  body: Record<string, unknown>,
) {
  const redirectUri = callbackUrl(body.redirectUri).href;
  const names = collectionNames(body.collections);
  return db.transaction().execute(async (tx) => {
    await lockOwner(tx, userId);
    await assertSiteOrigin(tx, userId, redirectUri);
    const existing = await tx
      .selectFrom("site_data_clients")
      .select("id")
      .where("user_id", "=", userId)
      .execute();
    if (existing.length >= 20)
      throw new DataError(409, "At most 20 website registrations are allowed.");
    if (
      await tx
        .selectFrom("site_data_clients")
        .select("id")
        .where("user_id", "=", userId)
        .where("redirect_uri", "=", redirectUri)
        .executeTakeFirst()
    ) {
      throw new DataError(
        409,
        "Callback already registered. Edit its registration to change access.",
      );
    }
    const collections = await scope(tx, userId, names);
    await siteClientId(userId, tx);
    return tx
      .insertInto("site_data_clients")
      .values({
        id: randomUUID(),
        user_id: userId,
        redirect_uri: redirectUri,
        collection_ids: collections.map((c) => c.id),
      })
      .returningAll()
      .executeTakeFirstOrThrow();
  });
}
export async function removeClient(userId: number, id: string) {
  await db.transaction().execute(async (tx) => {
    await lockOwner(tx, userId);
    await tx
      .deleteFrom("site_data_clients")
      .where("id", "=", id)
      .where("user_id", "=", userId)
      .execute();
  });
}
export async function revokeClientTokens(userId: number, id: string) {
  await db.transaction().execute(async (tx) => {
    await lockOwner(tx, userId);
    const client = await tx
      .selectFrom("site_data_clients")
      .select("id")
      .where("id", "=", id)
      .where("user_id", "=", userId)
      .executeTakeFirst();
    if (!client) throw new DataError(404, "Registration not found.");
    await clearClientGrants(tx, id);
  });
}
export type AuthorizationInput = ReturnType<typeof authorizationInput>;
export function authorizationInput(body: Record<string, unknown>) {
  const challenge = text(body.challenge, 43);
  const state = text(body.state, 128);
  if (
    !/^[A-Za-z0-9_-]{43}$/.test(challenge) ||
    !/^[A-Za-z0-9_-]{43,128}$/.test(state)
  )
    throw new DataError(400, "S256 PKCE challenge and random state required.");
  return {
    clientId: text(body.clientId, 64),
    site: name(body.site),
    redirectUri: text(body.redirectUri),
    challenge,
    state,
    collections: collectionNames(body.collections),
  };
}
async function authorizationDetails(
  tx: Kysely<DB>,
  userId: number,
  input: AuthorizationInput,
) {
  const client = await tx
    .selectFrom("site_data_clients as c")
    .innerJoin("users as u", "u.id", "c.user_id")
    .innerJoin("site_data_site_clients as w", "w.user_id", "c.user_id")
    .select(["c.id", "c.redirect_uri", "c.collection_ids", "u.login_name"])
    .where("w.id", "=", input.clientId)
    .where("c.redirect_uri", "=", input.redirectUri)
    .where("c.user_id", "=", userId)
    .executeTakeFirst();
  if (
    !client ||
    client.login_name !== input.site ||
    client.redirect_uri !== input.redirectUri
  )
    throw new DataError(
      403,
      "This request does not match your website registration.",
    );
  await assertSiteOrigin(tx, userId, client.redirect_uri);
  const collections = await scope(tx, userId, input.collections);
  if (collections.some((c) => !client.collection_ids.includes(c.id)))
    throw new DataError(403, "Requested collections exceed registered access.");
  return { client, collections };
}
export async function previewAuthorization(
  userId: number,
  input: AuthorizationInput,
) {
  return authorizationDetails(db, userId, input);
}
export async function approveAuthorization(
  userId: number,
  sessionId: string,
  input: AuthorizationInput,
) {
  return db.transaction().execute(async (tx) => {
    await lockOwner(tx, userId);
    const { client, collections } = await authorizationDetails(
      tx,
      userId,
      input,
    );
    const session = await tx
      .selectFrom("sessions")
      .select("id")
      .where("id", "=", sessionId)
      .where("user_id", "=", userId)
      .where("expires_at", ">", new Date())
      .executeTakeFirst();
    if (!session) throw denied();
    await tx
      .deleteFrom("site_data_auth_codes")
      .where("expires_at", "<=", new Date())
      .execute();
    await tx
      .deleteFrom("site_data_access_tokens")
      .where("expires_at", "<=", new Date())
      .execute();
    const live = await tx
      .selectFrom("site_data_auth_codes")
      .select("hash")
      .where("client_id", "=", client.id)
      .execute();
    if (live.length >= 20)
      throw new DataError(
        429,
        "Too many pending sign-ins. Try again in a minute.",
      );
    const code = secret();
    await tx
      .insertInto("site_data_auth_codes")
      .values({
        hash: digest(code),
        client_id: client.id,
        session_id: sessionId,
        collection_ids: collections.map((c) => c.id),
        challenge: input.challenge,
        expires_at: new Date(Date.now() + CODE_SECONDS * 1000),
      })
      .execute();
    const redirect = new URL(client.redirect_uri);
    redirect.searchParams.set("code", code);
    redirect.searchParams.set("state", input.state);
    return { redirect: redirect.href };
  });
}
export async function exchangeCode(
  body: Record<string, unknown>,
  origin: string | null,
) {
  const code = text(body.code, 128),
    verifier = text(body.verifier, 128);
  if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) throw denied();
  const clientId = text(body.clientId, 64),
    redirectUri = text(body.redirectUri);
  return db.transaction().execute(async (tx) => {
    // Lock owner first, matching data operations and revocation; never invert locks.
    const client = await tx
      .selectFrom("site_data_clients as c")
      .innerJoin("site_data_site_clients as w", "w.user_id", "c.user_id")
      .selectAll("c")
      .where("w.id", "=", clientId)
      .where("c.redirect_uri", "=", redirectUri)
      .executeTakeFirst();
    if (!client) throw denied();
    await lockOwner(tx, client.user_id);
    const current = await tx
      .selectFrom("site_data_clients")
      .selectAll()
      .where("id", "=", client.id)
      .executeTakeFirst();
    if (
      !current ||
      current.redirect_uri !== redirectUri ||
      origin !== new URL(current.redirect_uri).origin
    )
      throw denied();
    await assertSiteOrigin(tx, current.user_id, current.redirect_uri);
    const grant = await tx
      .selectFrom("site_data_auth_codes as g")
      .innerJoin("sessions as s", "s.id", "g.session_id")
      .select(["g.hash", "g.challenge", "g.session_id", "g.collection_ids"])
      .where("g.hash", "=", digest(code))
      .where("g.client_id", "=", client.id)
      .where("g.expires_at", ">", new Date())
      .where("s.expires_at", ">", new Date())
      .where("s.user_id", "=", current.user_id)
      .executeTakeFirst();
    if (
      !grant ||
      grant.challenge !== digest(verifier) ||
      grant.collection_ids.some((id) => !current.collection_ids.includes(id))
    )
      throw denied();
    // The owner lock makes concurrent exchanges single-use across processes.
    await tx
      .deleteFrom("site_data_auth_codes")
      .where("hash", "=", grant.hash)
      .execute();
    await tx
      .deleteFrom("site_data_access_tokens")
      .where("expires_at", "<=", new Date())
      .execute();
    const tokens = await tx
      .selectFrom("site_data_access_tokens")
      .select("hash")
      .where("client_id", "=", client.id)
      .execute();
    if (tokens.length >= 50)
      throw new DataError(
        429,
        "Too many active owner sessions. Revoke them in the control plane.",
      );
    const parent = await tx
      .selectFrom("sessions")
      .select("expires_at")
      .where("id", "=", grant.session_id)
      .executeTakeFirstOrThrow();
    const expiresAt = Math.min(
      Date.now() + TOKEN_SECONDS * 1000,
      new Date(parent.expires_at).getTime(),
    );
    const expiresIn = Math.floor((expiresAt - Date.now()) / 1000);
    if (expiresIn <= 0) throw denied();
    const accessToken = secret();
    await tx
      .insertInto("site_data_access_tokens")
      .values({
        hash: digest(accessToken),
        client_id: client.id,
        session_id: grant.session_id,
        collection_ids: grant.collection_ids,
        expires_at: new Date(expiresAt),
      })
      .execute();
    return { accessToken, tokenType: "Bearer", expiresIn, expiresAt };
  });
}

// Called inside executeData's owner transaction, before checking document rules.
export async function tokenScope(
  tx: Kysely<DB>,
  userId: number,
  token: string,
  origin: string | null,
) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw denied();
  const grant = await tx
    .selectFrom("site_data_access_tokens as t")
    .innerJoin("site_data_clients as c", "c.id", "t.client_id")
    .innerJoin("sessions as s", "s.id", "t.session_id")
    .select([
      "t.collection_ids",
      "c.collection_ids as registered_ids",
      "c.redirect_uri",
    ])
    .where("t.hash", "=", digest(token))
    .where("c.user_id", "=", userId)
    .where("s.user_id", "=", userId)
    .where("t.expires_at", ">", new Date())
    .where("s.expires_at", ">", new Date())
    .executeTakeFirst();
  if (!grant || !origin || origin !== new URL(grant.redirect_uri).origin)
    throw denied();
  await assertSiteOrigin(tx, userId, grant.redirect_uri);
  return grant.collection_ids.filter((id) => grant.registered_ids.includes(id));
}
export async function revokeToken(token: string, origin: string | null) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw denied();
  await db.transaction().execute(async (tx) => {
    const grant = await tx
      .selectFrom("site_data_access_tokens as t")
      .innerJoin("site_data_clients as c", "c.id", "t.client_id")
      .select(["c.user_id", "c.redirect_uri"])
      .where("t.hash", "=", digest(token))
      .executeTakeFirst();
    if (!grant) return; // Idempotent sign-out, including expired/deleted sessions.
    if (origin !== new URL(grant.redirect_uri).origin) throw denied();
    await lockOwner(tx, grant.user_id);
    await tx
      .deleteFrom("site_data_access_tokens")
      .where("hash", "=", digest(token))
      .execute();
  });
}

export async function limitPublicCreate(
  tx: Kysely<DB>,
  userId: number,
  clientIp?: string,
) {
  const window = new Date(Math.floor(Date.now() / 60000) * 60000);
  await tx
    .deleteFrom("site_data_rate_limits")
    .where("user_id", "=", userId)
    .where("window_start", "<", window)
    .execute();
  for (const [key, maximum] of [
    ["site", 60],
    [`ip:${digest(clientIp || "unknown")}`, 20],
  ] as const) {
    const bucket = await tx
      .selectFrom("site_data_rate_limits")
      .select("count")
      .where("user_id", "=", userId)
      .where("key", "=", key)
      .executeTakeFirst();
    if ((bucket?.count ?? 0) >= maximum)
      throw new DataError(
        429,
        "Public creation rate limit reached. Try again next minute.",
      );
    await tx
      .insertInto("site_data_rate_limits")
      .values({ user_id: userId, key, window_start: window, count: 1 })
      .onConflict((oc) =>
        oc
          .columns(["user_id", "key"])
          .doUpdateSet({ count: sql`site_data_rate_limits.count + 1` }),
      )
      .execute();
  }
}
