/** @jest-environment node */
import { afterAll, beforeAll, describe, expect, test } from "@jest/globals";
import { sql } from "kysely";
import { db } from "@/lib/database";
import { executeData } from "../service";
import {
  approveAuthorization,
  authorizationInput,
  digest,
  exchangeCode,
  siteClientId,
  updateClient,
  registerClient,
  removeClient,
  revokeClientTokens,
  revokeToken,
} from "../owner-auth";
import { setupTestDatabase, teardownTestDatabase } from "./test-database";

const integration =
  process.env.NARU_DATA_TEST === "1" ? describe : describe.skip;
integration("website owner authorization", () => {
  let ready = false,
    owner: number,
    bob: number,
    clientId: string,
    registrationId: string;
  const redirectUri = "https://alice.example/admin.html",
    origin = "https://alice.example";
  const verifier = "v".repeat(43);
  const authInput = (extra = {}) =>
    authorizationInput({
      clientId,
      site: "alice",
      redirectUri,
      state: "s".repeat(43),
      challenge: digest(verifier),
      collections: ["posts"],
      ...extra,
    });
  const issue = async () => {
    const response = await approveAuthorization(
      owner,
      "alice-session",
      authInput(),
    );
    return new URL(response.redirect).searchParams.get("code")!;
  };
  const exchange = (code: string, extra = {}, requestOrigin = origin) =>
    exchangeCode(
      { code, verifier, clientId, redirectUri, ...extra },
      requestOrigin,
    );
  const token = async () => (await exchange(await issue())).accessToken;
  const data = (
    accessToken: string,
    path: string[],
    method = "GET",
    body?: Record<string, unknown>,
    extra = {},
  ) =>
    executeData({
      site: "alice",
      path,
      method,
      body,
      bearer: { token: accessToken, origin },
      ...extra,
    });
  beforeAll(async () => {
    await setupTestDatabase();
    ready = true;
    owner = (
      await sql<{
        id: number;
      }>`insert into users(login_name) values ('alice') returning id`.execute(
        db,
      )
    ).rows[0].id;
    bob = (
      await sql<{
        id: number;
      }>`insert into users(login_name) values ('bob') returning id`.execute(db)
    ).rows[0].id;
    await sql`insert into sessions values ('alice-session', ${owner}, now() + interval '1 hour'), ('bob-session', ${bob}, now() + interval '1 hour')`.execute(
      db,
    );
    await sql`insert into custom_domains(user_id,hostname,verified_at,cloudflare_status,ssl_status) values (${owner}, 'alice.example', now(), 'active', 'active')`.execute(
      db,
    );
    for (const name of ["posts", "private", "recreated"])
      await executeData({
        site: "alice",
        path: [],
        method: "POST",
        adminUserId: owner,
        body: { name },
      });
    registrationId = (
      await registerClient(owner, {
        redirectUri,
        collections: ["posts", "recreated"],
      })
    ).id;
    clientId = await siteClientId(owner);
  });
  afterAll(async () => {
    if (ready) await teardownTestDatabase();
    await db.destroy();
  });
  test("registration and approval reject wrong domains, owner, callbacks and scope", async () => {
    await expect(
      registerClient(owner, {
        redirectUri: "https://evil.example/admin",
        collections: ["posts"],
      }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      registerClient(owner, {
        redirectUri: redirectUri + "?next=evil",
        collections: ["posts"],
      }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      registerClient(owner, { redirectUri, collections: ["posts"] }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      approveAuthorization(bob, "bob-session", authInput()),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      approveAuthorization(owner, "bob-session", authInput()),
    ).rejects.toMatchObject({ status: 401 });
    for (const extra of [
      { redirectUri: "https://evil.example/admin" },
      { site: "bob" },
      { collections: ["private"] },
    ]) {
      await expect(
        approveAuthorization(owner, "alice-session", authInput(extra)),
      ).rejects.toMatchObject({ status: 403 });
    }
    expect(() => authInput({ challenge: "plain" })).toThrow();
  });
  test("codes require the exact callback, origin and PKCE verifier; concurrent redemption is single use", async () => {
    const code = await issue();
    await expect(
      exchange(code, { verifier: "x".repeat(43) }),
    ).rejects.toMatchObject({ status: 401 });
    await expect(
      exchange(code, { redirectUri: redirectUri + "/" }),
    ).rejects.toMatchObject({ status: 401 });
    await expect(
      exchange(code, {}, "https://evil.example"),
    ).rejects.toMatchObject({ status: 401 });
    const outcomes = await Promise.allSettled([exchange(code), exchange(code)]);
    expect(outcomes.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.find((r) => r.status === "rejected")).toMatchObject({
      reason: { status: 401 },
    });
    const expired = await issue();
    await db
      .updateTable("site_data_auth_codes")
      .set({ expires_at: new Date(0) })
      .where("hash", "=", digest(expired))
      .execute();
    await expect(exchange(expired)).rejects.toMatchObject({ status: 401 });
  });
  test("tokens only grant scoped documents, not collection or cross-site access", async () => {
    const access = await token();
    await data(access, ["posts", "hello"], "PUT", { data: { title: "Hello" } });
    expect(await data(access, ["posts", "hello"])).toMatchObject({
      document: { data: { title: "Hello" } },
    });
    await expect(
      executeData({ site: "alice", path: ["posts"], method: "GET" }),
    ).rejects.toMatchObject({ status: 403 });
    for (const [path, method, body] of [
      [[], "POST", { name: "new" }],
      [[], "GET", undefined],
      [["posts"], "DELETE", undefined],
      [["posts"], "PATCH", { read: "world", write: "world" }],
      [["private"], "GET", undefined],
    ] as const) {
      await expect(data(access, [...path], method, body)).rejects.toMatchObject(
        { status: 403 },
      );
    }
    await expect(
      data(access, ["posts"], "GET", undefined, { site: "bob" }),
    ).rejects.toMatchObject({ status: 401 });
    await expect(
      data(access, ["posts"], "GET", undefined, {
        bearer: { token: access, origin: "https://evil.example" },
      }),
    ).rejects.toMatchObject({ status: 401 });
    await expect(
      data(access, ["posts"], "GET", undefined, {
        bearer: { token: access, origin: null },
      }),
    ).rejects.toMatchObject({ status: 401 });
    const stored = await db
      .selectFrom("site_data_access_tokens")
      .selectAll()
      .where("hash", "=", digest(access))
      .executeTakeFirstOrThrow();
    expect(stored.hash).not.toBe(access);
    expect(stored.expires_at.getTime() - Date.now()).toBeLessThanOrEqual(
      3600000,
    );
    await data(access, ["posts", "hello"], "DELETE");
  });
  test("deleted and recreated collections do not inherit old grants", async () => {
    const code = new URL(
      (
        await approveAuthorization(
          owner,
          "alice-session",
          authInput({ collections: ["recreated"] }),
        )
      ).redirect,
    ).searchParams.get("code")!;
    const access = (await exchange(code)).accessToken;
    await executeData({
      site: "alice",
      path: ["recreated"],
      method: "DELETE",
      adminUserId: owner,
    });
    await executeData({
      site: "alice",
      path: [],
      method: "POST",
      adminUserId: owner,
      body: { name: "recreated" },
    });
    await expect(data(access, ["recreated"])).rejects.toMatchObject({
      status: 403,
    });
  });
  test("sign-out, expiry, global revocation and session expiry take effect immediately", async () => {
    const access = await token();
    await expect(
      revokeToken(access, "https://evil.example"),
    ).rejects.toMatchObject({ status: 401 });
    await revokeToken(access, origin);
    await revokeToken(access, origin);
    await expect(data(access, ["posts"])).rejects.toMatchObject({
      status: 401,
    });
    const expired = await token();
    await db
      .updateTable("site_data_access_tokens")
      .set({ expires_at: new Date(0) })
      .where("hash", "=", digest(expired))
      .execute();
    await expect(data(expired, ["posts"])).rejects.toMatchObject({
      status: 401,
    });
    const revoked = await token(),
      pending = await issue();
    await revokeClientTokens(owner, registrationId);
    await expect(data(revoked, ["posts"])).rejects.toMatchObject({
      status: 401,
    });
    await expect(exchange(pending)).rejects.toMatchObject({ status: 401 });
    const sessionExpired = await token();
    await db
      .updateTable("sessions")
      .set({ expires_at: new Date(0) })
      .where("id", "=", "alice-session")
      .execute();
    await expect(data(sessionExpired, ["posts"])).rejects.toMatchObject({
      status: 401,
    });
    await db
      .updateTable("sessions")
      .set({ expires_at: new Date(Date.now() + 3600000) })
      .where("id", "=", "alice-session")
      .execute();
  });
  test("one stable website ID supports exact callbacks, edits revoke grants, and old callback IDs are rejected", async () => {
    const stable = await siteClientId(owner);
    await expect(
      approveAuthorization(
        owner,
        "alice-session",
        authInput({ clientId: registrationId }),
      ),
    ).rejects.toMatchObject({ status: 403 });
    const pending = await issue();
    await expect(
      exchange(pending, { clientId: registrationId }),
    ).rejects.toMatchObject({ status: 401 });
    await expect(exchange(pending)).resolves.toHaveProperty("accessToken");
    const callback2 = "https://alice.example/second.html";
    const second = await registerClient(owner, {
      redirectUri: callback2,
      collections: ["private"],
    });
    expect(await siteClientId(owner)).toBe(stable);
    await expect(
      approveAuthorization(
        owner,
        "alice-session",
        authInput({
          clientId: registrationId,
          redirectUri: callback2,
          collections: ["private"],
        }),
      ),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      approveAuthorization(
        owner,
        "alice-session",
        authInput({
          clientId: stable,
          redirectUri: callback2,
          collections: ["posts"],
        }),
      ),
    ).rejects.toMatchObject({ status: 403 });
    const response = await approveAuthorization(
      owner,
      "alice-session",
      authInput({
        clientId: stable,
        redirectUri: callback2,
        collections: ["private"],
      }),
    );
    const code = new URL(response.redirect).searchParams.get("code")!;
    const grant = await exchange(code, {
      clientId: stable,
      redirectUri: callback2,
    });
    expect(grant).toHaveProperty("accessToken");
    await expect(data(grant.accessToken, ["private"])).resolves.toBeDefined();
    await expect(
      updateClient(bob, second.id, {
        redirectUri: callback2,
        collections: ["posts"],
      }),
    ).rejects.toMatchObject({ status: 404 });
    await updateClient(owner, second.id, {
      redirectUri: callback2,
      collections: ["posts"],
    });
    expect(await siteClientId(owner)).toBe(stable);
    await expect(data(grant.accessToken, ["private"])).rejects.toMatchObject({
      status: 401,
    });
    await removeClient(owner, second.id);
    expect(await siteClientId(owner)).toBe(stable);
    await expect(exchange(await issue())).resolves.toHaveProperty(
      "accessToken",
    );
  });
  test("one opaque token lasts at most 24 hours, is stored hashed and is capped by the parent session", async () => {
    await db
      .updateTable("sessions")
      .set({ expires_at: new Date(Date.now() + 48 * 3600000) })
      .where("id", "=", "alice-session")
      .execute();
    const grant = await exchange(await issue());
    expect(grant.expiresIn).toBeGreaterThan(86390);
    expect(grant.expiresIn).toBeLessThanOrEqual(86400);
    expect(grant.expiresAt - Date.now()).toBeGreaterThan(24 * 3600000 - 5000);
    expect(grant).not.toHaveProperty("refreshToken");
    const stored = await db
      .selectFrom("site_data_access_tokens")
      .selectAll()
      .where("hash", "=", digest(grant.accessToken))
      .executeTakeFirstOrThrow();
    expect(stored.hash).not.toBe(grant.accessToken);
    expect(stored.expires_at.getTime()).toBe(grant.expiresAt);
    await expect(data(grant.accessToken, ["posts"])).resolves.toBeDefined();
    expect(
      (
        await db
          .selectFrom("site_data_access_tokens")
          .select("expires_at")
          .where("hash", "=", digest(grant.accessToken))
          .executeTakeFirstOrThrow()
      ).expires_at.getTime(),
    ).toBe(grant.expiresAt);
    const parentExpiry = new Date(Date.now() + 120000);
    await db
      .updateTable("sessions")
      .set({ expires_at: parentExpiry })
      .where("id", "=", "alice-session")
      .execute();
    const capped = await exchange(await issue());
    expect(capped.expiresAt).toBe(parentExpiry.getTime());
    await revokeToken(grant.accessToken, origin);
    await expect(data(grant.accessToken, ["posts"])).rejects.toMatchObject({
      status: 401,
    });
    await db
      .updateTable("sessions")
      .set({ expires_at: new Date(Date.now() + 3600000) })
      .where("id", "=", "alice-session")
      .execute();
  });
  test("lost domain verification, deleted sessions and removed registrations invalidate access", async () => {
    const access = await token();
    await sql`update custom_domains set verified_at = null`.execute(db);
    await expect(data(access, ["posts"])).rejects.toMatchObject({
      status: 403,
    });
    await sql`update custom_domains set verified_at = now()`.execute(db);
    await removeClient(bob, registrationId); // Cannot revoke another site's registration.
    await expect(data(access, ["posts"])).resolves.toBeDefined();
    const pending = await issue();
    await removeClient(owner, registrationId);
    await expect(data(access, ["posts"])).rejects.toMatchObject({
      status: 401,
    });
    await expect(exchange(pending)).rejects.toMatchObject({ status: 401 });
    registrationId = (
      await registerClient(owner, { redirectUri, collections: ["posts"] })
    ).id;
    const sessionDeleted = await token();
    await db.deleteFrom("sessions").where("id", "=", "alice-session").execute();
    await expect(data(sessionDeleted, ["posts"])).rejects.toMatchObject({
      status: 401,
    });
    expect(
      await db.selectFrom("site_data_access_tokens").selectAll().execute(),
    ).toEqual([]);
  });
});
