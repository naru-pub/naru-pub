/** @jest-environment node */
import { beforeEach, describe, expect, jest, test } from "@jest/globals";

// An in-memory sessions table behind the few Kysely chains auth.ts uses.
const sessions = new Map<string, { user_id: string; expires_at: Date }>();
const user = {
  user_id: "user-1",
  login_name: "alice",
  created_at: new Date("2026-01-01T00:00:00Z"),
  email: null,
  email_verified_at: null,
  discoverable: true,
};
jest.mock("../database", () => ({
  db: {
    selectFrom: () => {
      let id = "";
      const chain = {
        innerJoin: () => chain,
        select: () => chain,
        where: (_: string, __: string, value: string) => ((id = value), chain),
        executeTakeFirst: async () => {
          const row = sessions.get(id);
          return row
            ? {
                ...user,
                user_id: row.user_id,
                session_id: id,
                session_expires_at: row.expires_at,
              }
            : undefined;
        },
      };
      return chain;
    },
    insertInto: () => ({
      values: (row: { id: string; user_id: string; expires_at: Date }) => ({
        execute: async () => void sessions.set(row.id, row),
      }),
    }),
    deleteFrom: () => ({
      where: (_: string, __: string, id: string) => ({
        execute: async () => void sessions.delete(id),
      }),
    }),
    updateTable: () => ({
      set: (values: { expires_at: Date }) => ({
        where: (_: string, __: string, id: string) => ({
          execute: async () =>
            void sessions.set(id, { ...sessions.get(id)!, ...values }),
        }),
      }),
    }),
  },
}));
jest.mock("react", () => ({ cache: (fn: unknown) => fn }));

// The request's Cookie header, and the cookies the response sets. canSet is
// false while a page renders.
let cookieHeader = "";
let canSet = true;
let setCookies: Array<{ name: string; value: string; options: any }> = [];
jest.mock("next/headers", () => ({
  headers: async () => new Headers({ cookie: cookieHeader }),
  cookies: async () => {
    const jar = new Map<string, string>();
    for (const pair of cookieHeader.split(";")) {
      const [name, ...value] = pair.trim().split("=");
      if (name && !jar.has(name)) jar.set(name, value.join("="));
    }
    return {
      get: (name: string) =>
        jar.has(name) ? { name, value: jar.get(name)! } : undefined,
      has: (name: string) => jar.has(name),
      set: (name: string, value: string, options: unknown) => {
        if (!canSet) throw new Error("Cookies can only be modified in a route");
        setCookies.push({ name, value, options });
      },
    };
  },
}));

function loadAuth(nodeEnv: string): typeof import("../auth") {
  const previous = process.env.NODE_ENV;
  (process.env as Record<string, string>).NODE_ENV = nodeEnv;
  let auth!: typeof import("../auth");
  jest.isolateModules(() => {
    auth = require("../auth");
  });
  (process.env as Record<string, string>).NODE_ENV = previous!;
  return auth;
}

const inDays = (days: number) => new Date(Date.now() + days * 86_400_000);

beforeEach(() => {
  sessions.clear();
  cookieHeader = "";
  canSet = true;
  setCookies = [];
});

describe("production session cookie", () => {
  test("is issued as a __Host- cookie: Secure, Path=/, no Domain", async () => {
    const auth = loadAuth("production");
    const session = await auth.createSession("user-1");
    await auth.setSessionCookie(session);
    expect(setCookies).toEqual([
      {
        name: "__Host-auth_session",
        value: session.id,
        options: expect.objectContaining({ secure: true, path: "/" }),
      },
    ]);
    expect(setCookies[0].options).not.toHaveProperty("domain");
  });

  test("signs in with the __Host- cookie", async () => {
    const auth = loadAuth("production");
    sessions.set("current", { user_id: "user-1", expires_at: inDays(29) });
    cookieHeader = "__Host-auth_session=current";
    const result = await auth.validateRequest();
    expect(result.session?.id).toBe("current");
  });

  test("moves a legacy session to a new __Host- session", async () => {
    const auth = loadAuth("production");
    sessions.set("legacy", { user_id: "user-1", expires_at: inDays(20) });
    cookieHeader = "auth_session=legacy";

    const result = await auth.validateRequest();

    expect(result.user?.loginName).toBe("alice");
    expect(result.session?.id).not.toBe("legacy");
    expect(sessions.has("legacy")).toBe(false);
    expect(sessions.get(result.session!.id)?.user_id).toBe("user-1");
    expect(setCookies.map(({ name, value }) => [name, value])).toEqual([
      ["__Host-auth_session", result.session!.id],
      ["auth_session", ""],
    ]);
  });

  test("a legacy session can be moved only once", async () => {
    const auth = loadAuth("production");
    sessions.set("legacy", { user_id: "user-1", expires_at: inDays(20) });
    cookieHeader = "auth_session=legacy";
    await auth.validateRequest();
    const again = await auth.validateRequest();
    expect(again.user).toBeNull();
  });

  test("while a page renders, the legacy session serves without being moved or extended", async () => {
    const auth = loadAuth("production");
    const expiresAt = inDays(5);
    sessions.set("legacy", { user_id: "user-1", expires_at: expiresAt });
    cookieHeader = "auth_session=legacy";
    canSet = false;

    const result = await auth.validateRequest();

    expect(result.session?.id).toBe("legacy");
    expect([...sessions.keys()]).toEqual(["legacy"]);
    expect(sessions.get("legacy")?.expires_at).toBe(expiresAt);
  });

  test("two legacy cookies, one tossed next to the real one, sign in neither", async () => {
    const auth = loadAuth("production");
    sessions.set("attacker", { user_id: "user-2", expires_at: inDays(20) });
    sessions.set("victim", { user_id: "user-1", expires_at: inDays(20) });
    cookieHeader = "auth_session=attacker; auth_session=victim";

    const result = await auth.validateRequest();

    expect(result.user).toBeNull();
    expect(sessions.size).toBe(2);
  });

  test("a legacy cookie next to a __Host- one is ignored", async () => {
    const auth = loadAuth("production");
    sessions.set("current", { user_id: "user-1", expires_at: inDays(29) });
    sessions.set("attacker", { user_id: "user-2", expires_at: inDays(20) });
    cookieHeader = "auth_session=attacker; __Host-auth_session=current";

    const result = await auth.validateRequest();

    expect(result.session?.id).toBe("current");
    expect(setCookies.map(({ name, value }) => [name, value])).toEqual([
      ["auth_session", ""],
    ]);
  });
});

describe("development session cookie", () => {
  test("keeps the plain name over http, where __Host- can't be set", async () => {
    const auth = loadAuth("development");
    sessions.set("dev", { user_id: "user-1", expires_at: inDays(29) });
    cookieHeader = "auth_session=dev";

    const result = await auth.validateRequest();
    await auth.setSessionCookie(result.session!);

    expect(result.session?.id).toBe("dev");
    expect(setCookies).toEqual([
      {
        name: "auth_session",
        value: "dev",
        options: expect.objectContaining({ secure: false }),
      },
    ]);
  });
});
