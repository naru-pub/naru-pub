import { cache } from "react";
import { cookies } from "next/headers";
import { db } from "./database";
import { generateId } from "./id";

// Lucia v3's default session cookie name. Kept identical so sessions issued
// before this migration stay valid.
const SESSION_COOKIE_NAME = "auth_session";
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
  const id = generateId(40);
  const expiresAt = new Date(Date.now() + SESSION_EXPIRES_IN_MS);
  await db
    .insertInto("sessions")
    .values({ id, user_id: userId, expires_at: expiresAt })
    .execute();
  return { id, userId, expiresAt, fresh: true };
}

export async function validateSession(
  sessionId: string,
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
  if (Date.now() >= expiresAt.getTime() - SESSION_EXPIRES_IN_MS / 2) {
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
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_COOKIE_MAX_AGE,
  });
}

export async function deleteSessionCookie(): Promise<void> {
  (await cookies()).set(SESSION_COOKIE_NAME, "", {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 0,
  });
}

export const validateRequest = cache(
  async (): Promise<
    { user: User; session: Session } | { user: null; session: null }
  > => {
    const sessionId = (await cookies()).get(SESSION_COOKIE_NAME)?.value ?? null;
    if (!sessionId) {
      return {
        user: null,
        session: null,
      };
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
  },
);
