import { createHash, randomBytes } from "node:crypto";
import { uuidv7 } from "@/lib/uuid";
import { Kysely, sql } from "kysely";
import type { DB } from "@/lib/db";
import { db } from "@/lib/database";
import { DataError, name, unreservedName, uuidId } from "./validation";
import { siteDataBackend } from "./backend";

export const TOKEN_SECONDS = 24 * 60 * 60;
export function tokenLifetime(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 60 ||
    value > TOKEN_SECONDS ||
    value % 60 !== 0
  )
    throw new DataError(
      400,
      "Token lifetime must be 1-1440 whole minutes (in seconds).",
    );
  return value;
}
const CODE_SECONDS = 60;
// However long a token's idle window is, it is never renewed past this much
// time after it was issued: a stolen token cannot be kept alive indefinitely.
export const TOKEN_CAP_SECONDS = 7 * 24 * 60 * 60;
export const digest = (value: string) =>
  createHash("sha256").update(value).digest("base64url");
const secret = () => randomBytes(32).toString("base64url");
const denied = () =>
  new DataError(
    401,
    "Owner authorization is invalid, expired or revoked.",
    "AUTH_REQUIRED",
  );

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

/**
 * The page the site proxy serves at a path: `/` and `/index.html` are one
 * page, as are `/about`, `/about/` and `/about/index.html`. Kept here, beside
 * the proxy it mirrors, rather than in the SDK, which cannot change with it.
 */
function page(url: URL) {
  const path = url.pathname;
  const last = path.slice(path.lastIndexOf("/") + 1);
  const file =
    last.includes(".") && !last.startsWith(".") && !last.endsWith(".");
  const canonical =
    last === "index.html"
      ? path.slice(0, -last.length)
      : file || path.endsWith("/")
        ? path
        : `${path}/`;
  return url.origin + canonical;
}

/**
 * A registration is for a page, so a callback matches it from any address
 * that page is served at. Registrations are stored as the owner typed them.
 */
export function sameCallback(registered: string, requested: string) {
  try {
    return page(callbackUrl(registered)) === page(callbackUrl(requested));
  } catch {
    return false;
  }
}

// Rechecked at registration, approval, exchange and every authenticated data call.
// Removing or de-verifying a custom domain therefore invalidates its access.
async function assertSiteOrigin(
  tx: Kysely<DB>,
  userId: string,
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

async function lockOwner(tx: Kysely<DB>, userId: string) {
  await tx
    .selectFrom("users")
    .select("id")
    .where("id", "=", userId)
    .forUpdate()
    .executeTakeFirstOrThrow();
}
/** The site's collections by name, from whichever store holds them. */
async function siteCollections(
  tx: Kysely<DB>,
  userId: string,
  names: string[],
) {
  const owner = await tx
    .selectFrom("users")
    .select(["id", "login_name as loginName"])
    .where("id", "=", userId)
    .executeTakeFirstOrThrow();
  return (await siteDataBackend(owner.loginName, tx)).collections(
    owner,
    names,
    tx,
  );
}
async function scope(tx: Kysely<DB>, userId: string, names: string[]) {
  const rows = await siteCollections(tx, userId, names);
  if (rows.length !== names.length)
    throw new DataError(
      400,
      `Collections do not exist: ${names
        .filter((n) => !rows.some((row) => row.name === n))
        .join(", ")}. Create them in the control panel.`,
    );
  return rows;
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
  userId: string,
  id: string,
  body: Record<string, unknown>,
) {
  id = uuidId(id);
  const names =
    body.collections === undefined
      ? undefined
      : collectionNames(body.collections);
  return db.transaction().execute(async (tx) => {
    await lockOwner(tx, userId);
    const current = await tx
      .selectFrom("site_data_clients")
      .selectAll()
      .where("id", "=", id)
      .where("user_id", "=", userId)
      .executeTakeFirst();
    if (!current) throw new DataError(404, "Registration not found.");
    const redirectUri =
      body.redirectUri === undefined
        ? current.redirect_uri
        : callbackUrl(body.redirectUri).href;
    await assertSiteOrigin(tx, userId, redirectUri);
    const others = await tx
      .selectFrom("site_data_clients")
      .select("redirect_uri")
      .where("user_id", "=", userId)
      .where("id", "!=", id)
      .execute();
    if (others.some((c) => sameCallback(c.redirect_uri, redirectUri)))
      throw new DataError(409, "Callback already registered.");
    const collections = names
      ? await scope(tx, userId, names)
      : current.collection_ids.map((id) => ({ id }));
    const lifetime =
      body.tokenLifetimeSeconds === undefined
        ? current.token_lifetime_seconds
        : tokenLifetime(body.tokenLifetimeSeconds);
    const ids = collections.map((c) => c.id);
    if (
      current.redirect_uri !== redirectUri ||
      lifetime < current.token_lifetime_seconds ||
      ids.length !== current.collection_ids.length ||
      ids.some((id) => !current.collection_ids.includes(id))
    ) {
      await clearClientGrants(tx, id);
    }
    await tx
      .updateTable("site_data_clients")
      .set({
        redirect_uri: redirectUri,
        token_lifetime_seconds: lifetime,
        collection_ids: collections.map((c) => c.id),
      })
      .where("id", "=", id)
      .execute();
  });
}

export async function registerClient(
  userId: string,
  body: Record<string, unknown>,
) {
  const redirectUri = callbackUrl(body.redirectUri).href;
  const names = collectionNames(body.collections);
  const lifetime = tokenLifetime(
    body.tokenLifetimeSeconds === undefined
      ? TOKEN_SECONDS
      : body.tokenLifetimeSeconds,
  );
  return db.transaction().execute(async (tx) => {
    await lockOwner(tx, userId);
    await assertSiteOrigin(tx, userId, redirectUri);
    const existing = await tx
      .selectFrom("site_data_clients")
      .select("redirect_uri")
      .where("user_id", "=", userId)
      .execute();
    if (existing.length >= 20)
      throw new DataError(409, "At most 20 website registrations are allowed.");
    if (existing.some((c) => sameCallback(c.redirect_uri, redirectUri))) {
      throw new DataError(
        409,
        "Callback already registered. Edit its registration to change access.",
      );
    }
    const collections = await scope(tx, userId, names);
    return tx
      .insertInto("site_data_clients")
      .values({
        id: uuidv7(),
        user_id: userId,
        redirect_uri: redirectUri,
        token_lifetime_seconds: lifetime,
        collection_ids: collections.map((c) => c.id),
      })
      .returningAll()
      .executeTakeFirstOrThrow();
  });
}
export async function removeClient(userId: string, id: string) {
  id = uuidId(id);
  await db.transaction().execute(async (tx) => {
    await lockOwner(tx, userId);
    await tx
      .deleteFrom("site_data_clients")
      .where("id", "=", id)
      .where("user_id", "=", userId)
      .execute();
  });
}
export async function revokeClientTokens(userId: string, id: string) {
  id = uuidId(id);
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
  // A clientId from an SDK released before sign-in dropped it is ignored: the
  // site and exact callback identify the registration on their own.
  return {
    site: name(body.site),
    redirectUri: text(body.redirectUri),
    challenge,
    state,
    collections: collectionNames(body.collections),
    ...(body.tokenLifetimeSeconds === undefined
      ? {}
      : { tokenLifetimeSeconds: tokenLifetime(body.tokenLifetimeSeconds) }),
  };
}
async function authorizationDetails(
  tx: Kysely<DB>,
  userId: string,
  input: AuthorizationInput,
) {
  const owner = await tx
    .selectFrom("users")
    .select("login_name")
    .where("id", "=", userId)
    .executeTakeFirst();
  if (owner?.login_name !== input.site)
    throw new DataError(
      403,
      `이 요청은 ${input.site} 사이트의 관리자 로그인입니다. 그 사이트의 나루 계정으로 로그인해 주세요.`,
    );
  const client = (
    await tx
      .selectFrom("site_data_clients")
      .select([
        "id",
        "redirect_uri",
        "collection_ids",
        "token_lifetime_seconds",
      ])
      .where("user_id", "=", userId)
      .execute()
  ).find((c) => sameCallback(c.redirect_uri, input.redirectUri));
  // Reported here, on Naru, rather than on the site: this is where it is fixed.
  // The address is shown as text only, never linked or redirected to, since
  // anyone can craft this request.
  if (!client)
    throw new DataError(
      403,
      `관리자 로그인에 등록되지 않은 페이지입니다: ${input.redirectUri} — 제어판의 ‘웹사이트 관리자 로그인’에서 이 주소를 등록한 뒤 웹사이트에서 다시 로그인해 주세요.`,
    );
  await assertSiteOrigin(tx, userId, client.redirect_uri);
  const collections = await scope(tx, userId, input.collections);
  const missing = collections.filter(
    (c) => !client.collection_ids.includes(c.id),
  );
  if (missing.length)
    throw new DataError(
      403,
      `이 관리자 페이지에 허용되지 않은 컬렉션을 요청했습니다: ${missing.map((c) => c.name).join(", ")}. 제어판의 ‘웹사이트 관리자 로그인’에서 해당 관리자 페이지를 수정하여 필요한 컬렉션을 선택한 뒤, 웹사이트에서 다시 로그인해 주세요.`,
    );
  return { client, collections };
}
/**
 * What the owner could fix on the consent page itself, rather than being sent
 * to the control panel: registering the page, creating collections the site
 * asks for, or adding them to the page's registration. Null when there is
 * nothing to fix, or when what is wrong is not the owner's to fix here (the
 * wrong account, or a page off their site).
 */
export type AuthorizationSetup = {
  register: boolean;
  create: string[];
  extend: string[];
};
async function setupNeeded(
  tx: Kysely<DB>,
  userId: string,
  input: AuthorizationInput,
): Promise<AuthorizationSetup | null> {
  const owner = await tx
    .selectFrom("users")
    .select("login_name")
    .where("id", "=", userId)
    .executeTakeFirst();
  if (owner?.login_name !== input.site) return null;
  try {
    await assertSiteOrigin(tx, userId, input.redirectUri);
  } catch {
    return null;
  }
  const rows = await siteCollections(tx, userId, input.collections);
  const create = input.collections.filter(
    (wanted) => !rows.some((row) => row.name === wanted),
  );
  const client = (
    await tx
      .selectFrom("site_data_clients")
      .select(["redirect_uri", "collection_ids"])
      .where("user_id", "=", userId)
      .execute()
  ).find((c) => sameCallback(c.redirect_uri, input.redirectUri));
  const extend = client
    ? rows
        .filter((row) => !client.collection_ids.includes(row.id))
        .map((row) => row.name)
    : [];
  if (client && !create.length && !extend.length) return null;
  return { register: !client, create, extend };
}
export function authorizationSetup(userId: string, input: AuthorizationInput) {
  return setupNeeded(db, userId, input);
}

/**
 * Applies what authorizationSetup reported, in one transaction. New
 * collections start private (admin read and write), like any collection made
 * in the control panel. Changing a registration's collections revokes its
 * outstanding sign-ins, as editing it in the control panel does.
 */
export async function prepareAuthorization(
  userId: string,
  input: AuthorizationInput,
) {
  await db.transaction().execute(async (tx) => {
    await lockOwner(tx, userId);
    const setup = await setupNeeded(tx, userId, input);
    if (!setup) return;
    if (setup.create.length) {
      const owner = await tx
        .selectFrom("users")
        .select(["id", "login_name as loginName"])
        .where("id", "=", userId)
        .executeTakeFirstOrThrow();
      // In PostgreSQL this joins the transaction; another store commits now,
      // and a registration that then fails leaves only empty collections.
      const created = await (
        await siteDataBackend(owner.loginName, tx)
      ).createCollections(
        owner,
        setup.create.map((collection) => ({
          name: unreservedName(collection),
          read_access: "admin",
          write_access: "admin",
        })),
        tx,
      );
      if (created === null)
        throw new DataError(409, "Collection limit reached.", "QUOTA_EXCEEDED");
    }
    const ids = (await scope(tx, userId, input.collections)).map((c) => c.id);
    const clients = await tx
      .selectFrom("site_data_clients")
      .select(["id", "redirect_uri", "collection_ids"])
      .where("user_id", "=", userId)
      .execute();
    if (setup.register) {
      if (clients.length >= 20)
        throw new DataError(
          409,
          "At most 20 website registrations are allowed.",
        );
      await tx
        .insertInto("site_data_clients")
        .values({
          id: uuidv7(),
          user_id: userId,
          redirect_uri: callbackUrl(input.redirectUri).href,
          token_lifetime_seconds: TOKEN_SECONDS,
          collection_ids: ids,
        })
        .execute();
      return;
    }
    const client = clients.find((c) =>
      sameCallback(c.redirect_uri, input.redirectUri),
    )!;
    await clearClientGrants(tx, client.id);
    await tx
      .updateTable("site_data_clients")
      .set({
        collection_ids: [...new Set([...client.collection_ids, ...ids])],
      })
      .where("id", "=", client.id)
      .execute();
  });
}

export async function previewAuthorization(
  userId: string,
  input: AuthorizationInput,
) {
  return authorizationDetails(db, userId, input);
}
export async function approveAuthorization(
  userId: string,
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
        token_lifetime_seconds: Math.min(
          client.token_lifetime_seconds,
          input.tokenLifetimeSeconds ?? TOKEN_SECONDS,
        ),
        expires_at: new Date(Date.now() + CODE_SECONDS * 1000),
      })
      .execute();
    // Back to the address the sign-in left from, which the SDK keeps its
    // pending sign-in under. It matched the registered page just above.
    const redirect = callbackUrl(input.redirectUri);
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
  // Any clientId an older SDK still sends is ignored. The code is a secret bound
  // to one registration, so it names the registration by itself.
  const redirectUri = text(body.redirectUri);
  return db.transaction().execute(async (tx) => {
    // Lock owner first, matching data operations and revocation; never invert locks.
    const client = await tx
      .selectFrom("site_data_auth_codes as g")
      .innerJoin("site_data_clients as c", "c.id", "g.client_id")
      .select(["c.id", "c.user_id", "c.redirect_uri"])
      .where("g.hash", "=", digest(code))
      .executeTakeFirst();
    if (!client || !sameCallback(client.redirect_uri, redirectUri))
      throw denied();
    await lockOwner(tx, client.user_id);
    const current = await tx
      .selectFrom("site_data_clients")
      .selectAll()
      .where("id", "=", client.id)
      .executeTakeFirst();
    if (
      !current ||
      !sameCallback(current.redirect_uri, redirectUri) ||
      origin !== new URL(current.redirect_uri).origin
    )
      throw denied();
    await assertSiteOrigin(tx, current.user_id, current.redirect_uri);
    const grant = await tx
      .selectFrom("site_data_auth_codes as g")
      .innerJoin("sessions as s", "s.id", "g.session_id")
      .select([
        "g.hash",
        "g.challenge",
        "g.session_id",
        "g.collection_ids",
        "g.token_lifetime_seconds",
      ])
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
    const lifetime = Math.min(
      TOKEN_SECONDS,
      current.token_lifetime_seconds,
      grant.token_lifetime_seconds,
    );
    const expiresAt = Math.min(
      Date.now() + lifetime * 1000,
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
        lifetime_seconds: lifetime,
        expires_at: new Date(expiresAt),
      })
      .execute();
    return { accessToken, tokenType: "Bearer", expiresIn, expiresAt };
  });
}

/**
 * A token's lifetime is an idle window, so using it renews it. Renewal stops at
 * whichever comes first: the cap on the token's whole life, the owner's Naru
 * login, or a lifetime the registration has since lowered. Like a Naru login,
 * it is only rewritten past the halfway mark, so a working tab costs one extra
 * write per half-window rather than one per request.
 */
function renewal(grant: {
  issued_at: Date;
  expires_at: Date;
  lifetime_seconds: number;
  client_lifetime_seconds: number;
  session_expires_at: Date;
}) {
  const expiresAt = new Date(grant.expires_at).getTime();
  const lifetime =
    Math.min(grant.lifetime_seconds, grant.client_lifetime_seconds) * 1000;
  if (Date.now() < expiresAt - lifetime / 2) return expiresAt;
  const renewed = Math.min(
    Date.now() + lifetime,
    new Date(grant.issued_at).getTime() + TOKEN_CAP_SECONDS * 1000,
    new Date(grant.session_expires_at).getTime(),
  );
  return Math.max(expiresAt, renewed);
}

/**
 * Called inside executeData's owner transaction, before checking document
 * rules. Renews the token as a side effect and reports the expiry it now has,
 * so the SDK holding it can keep its own copy current.
 */
export async function tokenScope(
  tx: Kysely<DB>,
  userId: string,
  bearer: { token: string; origin: string | null; expiresAt?: number },
) {
  const { token, origin } = bearer;
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw denied();
  const grant = await tx
    .selectFrom("site_data_access_tokens as t")
    .innerJoin("site_data_clients as c", "c.id", "t.client_id")
    .innerJoin("sessions as s", "s.id", "t.session_id")
    .select([
      "t.collection_ids",
      "t.issued_at",
      "t.expires_at",
      "t.lifetime_seconds",
      "c.collection_ids as registered_ids",
      "c.redirect_uri",
      "c.token_lifetime_seconds as client_lifetime_seconds",
      "s.expires_at as session_expires_at",
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
  const expiresAt = renewal(grant);
  // Reported only when it moved: the SDK already holds the expiry otherwise.
  if (expiresAt !== new Date(grant.expires_at).getTime()) {
    await tx
      .updateTable("site_data_access_tokens")
      .set({ expires_at: new Date(expiresAt) })
      .where("hash", "=", digest(token))
      .execute();
    bearer.expiresAt = expiresAt;
  }
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

/**
 * Bounds writes that arrive with no owner credential. Every such write takes
 * the owner row lock and re-aggregates the site's whole document usage, so an
 * unbounded stranger-driven write is expensive far out of proportion to the
 * request that caused it. A `world`-writable collection is as reachable as a
 * `create` one, so both are counted here.
 */
const currentWindow = () => new Date(Math.floor(Date.now() / 60000) * 60000);
const publicWriteBuckets = (clientIp?: string) =>
  [
    ["site", 60],
    [`ip:${digest(clientIp || "unknown")}`, 20],
  ] as const;
const rateLimited = () =>
  new DataError(429, "Public write rate limit reached. Try again next minute.");

/**
 * Refuses a public write that is already over its limit, before it queues for
 * the owner row lock. A burst past the limit would otherwise wait in line
 * behind the site's legitimate writes only to be refused at the front of it.
 * One unlocked read: it can let a request through that the locked count below
 * then refuses, but never refuses one that would have been allowed.
 */
export async function refusePublicWriteOverLimit(
  site: string,
  clientIp?: string,
) {
  const buckets = publicWriteBuckets(clientIp);
  const counts = await db
    .selectFrom("site_data_rate_limits as r")
    .innerJoin("users as u", "u.id", "r.user_id")
    .select(["r.key", "r.count"])
    .where("u.login_name", "=", site)
    .where("r.window_start", ">=", currentWindow())
    .where(
      "r.key",
      "in",
      buckets.map(([key]) => key),
    )
    .execute();
  for (const [key, maximum] of buckets)
    if ((counts.find((row) => row.key === key)?.count ?? 0) >= maximum)
      throw rateLimited();
}

export async function limitPublicWrite(
  tx: Kysely<DB>,
  userId: string,
  clientIp?: string,
) {
  const window = currentWindow();
  await tx
    .deleteFrom("site_data_rate_limits")
    .where("user_id", "=", userId)
    .where("window_start", "<", window)
    .execute();
  for (const [key, maximum] of publicWriteBuckets(clientIp)) {
    const bucket = await tx
      .selectFrom("site_data_rate_limits")
      .select("count")
      .where("user_id", "=", userId)
      .where("key", "=", key)
      .executeTakeFirst();
    if ((bucket?.count ?? 0) >= maximum) throw rateLimited();
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
