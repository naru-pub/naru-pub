import { cache } from "react";
import { cookies, headers } from "next/headers";
import { db } from "./database";
import { generateId } from "./id";

// Sites on <login>.naru.pub run arbitrary scripts and share naru.pub's cookie
// scope (naru.pub is not a public suffix), so they can set a Domain=naru.pub
// cookie that the control plane would read: a visitor would be signed into the
// site's author's account. Browsers only accept a __Host- cookie that is
// Secure, Path=/ and has no Domain, so no subdomain can set or shadow it.
// __Host- needs Secure, which local development over http can't set; there the
// plain name is used, as before.
const SECURE_COOKIES = process.env.NODE_ENV === "production";
const SESSION_COOKIE_NAME = SECURE_COOKIES
  ? "__Host-auth_session"
  : "auth_session";
// The name sessions were issued under before. A subdomain can set it too, so
// it is only accepted to move a session over to the new name, with the limits
// in upgradeLegacySession, and not at all after LEGACY_SESSION_ACCEPTED_UNTIL.
// Legacy sessions are never extended, so every one has expired within 30 days
// of the deploy; after that this fallback can be deleted.
const LEGACY_SESSION_COOKIE_NAME = "auth_session";
const LEGACY_SESSION_ACCEPTED_UNTIL = new Date("2026-10-31T00:00:00+09:00");
// Sessions live for 30 days and are extended once they pass their halfway
// point, matching Lucia's previous behavior.
const SESSION_EXPIRES_IN_MS = 1000 * 60 * 60 * 24 * 30;
// Lucia set cookies with `expires: false`, i.e. a very long lived cookie. The
// session row in the database is the real source of truth for validity.
const SESSION_COOKIE_MAX_AGE = 60 * 60 * 24 * 400;

export interface User {
  id: string;
  loginName: string;
  createdAt: Date;
  email: string | null;
  emailVerifiedAt: Date | null;
  discoverable: boolean;
}

export interface Session {
  id: string;
  userId: string;
  expiresAt: Date;
  fresh: boolean;
}

export async function createSession(userId: string): Promise<Session> {
  const session = newSession(userId);
  await insertSession(session);
  return session;
}

function newSession(userId: string): Session {
  const id = generateId(40);
  const expiresAt = new Date(Date.now() + SESSION_EXPIRES_IN_MS);
  return { id, userId, expiresAt, fresh: true };
}

async function insertSession(session: Session): Promise<void> {
  await db
    .insertInto("sessions")
    .values({
      id: session.id,
      user_id: session.userId,
      expires_at: session.expiresAt,
    })
    .execute();
}

export async function validateSession(
  sessionId: string,
  { extend = true }: { extend?: boolean } = {},
): Promise<{ user: User; session: Session } | { user: null; session: null }> {
  const row = await db
    .selectFrom("sessions")
    .innerJoin("users", "users.id", "sessions.user_id")
    .select([
      "sessions.id as session_id",
      "sessions.expires_at as session_expires_at",
      "users.id as user_id",
      "users.login_name",
      "users.created_at",
      "users.email",
      "users.email_verified_at",
      "users.discoverable",
    ])
    .where("sessions.id", "=", sessionId)
    .executeTakeFirst();

  if (!row) {
    return { user: null, session: null };
  }

  const expiresAt = new Date(row.session_expires_at);

  // Expired session: clean it up and treat the request as unauthenticated.
  if (Date.now() >= expiresAt.getTime()) {
    await db.deleteFrom("sessions").where("id", "=", sessionId).execute();
    return { user: null, session: null };
  }

  // Extend the session once it passes the halfway point of its lifetime.
  let fresh = false;
  let effectiveExpiresAt = expiresAt;
  if (extend && Date.now() >= expiresAt.getTime() - SESSION_EXPIRES_IN_MS / 2) {
    effectiveExpiresAt = new Date(Date.now() + SESSION_EXPIRES_IN_MS);
    await db
      .updateTable("sessions")
      .set({ expires_at: effectiveExpiresAt })
      .where("id", "=", sessionId)
      .execute();
    fresh = true;
  }

  return {
    session: {
      id: row.session_id,
      userId: row.user_id,
      expiresAt: effectiveExpiresAt,
      fresh,
    },
    user: {
      id: row.user_id,
      loginName: row.login_name,
      createdAt: new Date(row.created_at),
      email: row.email,
      emailVerifiedAt: row.email_verified_at
        ? new Date(row.email_verified_at)
        : null,
      discoverable: row.discoverable,
    },
  };
}

export async function invalidateSession(sessionId: string): Promise<void> {
  await db.deleteFrom("sessions").where("id", "=", sessionId).execute();
}

export async function setSessionCookie(session: Session): Promise<void> {
  (await cookies()).set(SESSION_COOKIE_NAME, session.id, {
    httpOnly: true,
    sameSite: "lax",
    secure: SECURE_COOKIES,
    path: "/",
    maxAge: SESSION_COOKIE_MAX_AGE,
  });
}

export async function deleteSessionCookie(): Promise<void> {
  (await cookies()).set(SESSION_COOKIE_NAME, "", {
    httpOnly: true,
    sameSite: "lax",
    secure: SECURE_COOKIES,
    path: "/",
    maxAge: 0,
  });
}

type CookieStore = Awaited<ReturnType<typeof cookies>>;
type AuthResult =
  | { user: User; session: Session }
  | { user: null; session: null };

// Throws while a page renders, like any cookie write.
function clearLegacySessionCookie(cookieStore: CookieStore): void {
  cookieStore.set(LEGACY_SESSION_COOKIE_NAME, "", {
    httpOnly: true,
    sameSite: "lax",
    secure: true,
    path: "/",
    maxAge: 0,
  });
}

// Moves a session issued under the legacy cookie name to a new session under
// the __Host- name, so existing sign-ins survive the rename.
//
// The server can't tell the cookie it set from one a subdomain tossed, so:
// - Two legacy cookies in one request mean one was tossed next to the real one
//   (a Domain=naru.pub cookie is sent alongside the host-only one); neither is
//   used.
// - The legacy id is replaced by a new one and deleted, so each legacy session
//   can be moved once, and the attacker's copy of a tossed id stops working.
// - Without a __Host- cookie or a real legacy one (a signed-out visitor), a
//   tossed legacy cookie still signs the visitor in as the site's author, as
//   it did before this change, until LEGACY_SESSION_ACCEPTED_UNTIL. Only
//   sessions the previous release issued exist to be tossed.
async function upgradeLegacySession(
  cookieStore: CookieStore,
): Promise<AuthResult | null> {
  const sent = ((await headers()).get("cookie") ?? "")
    .split(";")
    .filter(
      (pair) => pair.split("=")[0].trim() === LEGACY_SESSION_COOKIE_NAME,
    ).length;
  if (sent === 0) return null;

  const legacyId = cookieStore.get(LEGACY_SESSION_COOKIE_NAME)?.value;
  const result =
    sent === 1 &&
    legacyId &&
    Date.now() < LEGACY_SESSION_ACCEPTED_UNTIL.getTime()
      ? await validateSession(legacyId, { extend: false })
      : null;
  if (!result?.user) {
    try {
      clearLegacySessionCookie(cookieStore);
    } catch {}
    return null;
  }

  // The row goes in only once the cookie is set: while a page renders, which
  // can't set cookies, the legacy session serves the request and is moved by
  // the next route handler or server action.
  const session = newSession(result.user.id);
  try {
    await setSessionCookie(session);
    clearLegacySessionCookie(cookieStore);
  } catch {
    return result;
  }
  await insertSession(session);
  await invalidateSession(legacyId!);
  return { user: result.user, session };
}

export const validateRequest = cache(async (): Promise<AuthResult> => {
  const cookieStore = await cookies();
  const sessionId = cookieStore.get(SESSION_COOKIE_NAME)?.value ?? null;
  if (!sessionId) {
    const upgraded = SECURE_COOKIES
      ? await upgradeLegacySession(cookieStore)
      : null;
    return upgraded ?? { user: null, session: null };
  }
  if (SECURE_COOKIES && cookieStore.has(LEGACY_SESSION_COOKIE_NAME)) {
    // Signed in under the new name already; whatever the legacy cookie
    // holds (a leftover or a tossed one) is ignored.
    try {
      clearLegacySessionCookie(cookieStore);
    } catch {}
  }

  const result = await validateSession(sessionId);
  // next.js throws when you attempt to set a cookie while rendering a page.
  try {
    if (result.session && result.session.fresh) {
      await setSessionCookie(result.session);
    }
    if (!result.session) {
      await deleteSessionCookie();
    }
  } catch {}
  return result;
});
