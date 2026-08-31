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
    clientId: string;
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
    clientId = (
      await registerClient(owner, {
        redirectUri,
        collections: ["posts", "recreated"],
      })
    ).id;
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
      600000,
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
    await revokeClientTokens(owner, clientId);
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
  test("lost domain verification, deleted sessions and removed registrations invalidate access", async () => {
    const access = await token();
    await sql`update custom_domains set verified_at = null`.execute(db);
    await expect(data(access, ["posts"])).rejects.toMatchObject({
      status: 403,
    });
    await sql`update custom_domains set verified_at = now()`.execute(db);
    await removeClient(bob, clientId); // Cannot revoke another site's registration.
    await expect(data(access, ["posts"])).resolves.toBeDefined();
    const pending = await issue();
    await removeClient(owner, clientId);
    await expect(data(access, ["posts"])).rejects.toMatchObject({
      status: 401,
    });
    await expect(exchange(pending)).rejects.toMatchObject({ status: 401 });
    clientId = (
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
