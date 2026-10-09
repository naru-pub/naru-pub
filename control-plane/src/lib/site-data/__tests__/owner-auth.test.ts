/** @jest-environment node */
import { afterAll, beforeAll, describe, expect, test } from "@jest/globals";
import { sql } from "kysely";
import { db } from "@/lib/database";
import { executeData, listCollections } from "../service";
import { eraseSiteData } from "@/lib/edge/client";
import {
  approveAuthorization,
  authorizationInput,
  authorizationSetup,
  digest,
  prepareAuthorization,
  exchangeCode,
  updateClient,
  tokenLifetime,
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
    owner: string,
    bob: string,
    registrationId: string;
  const redirectUri = "https://alice.example/admin.html",
    origin = "https://alice.example";
  const verifier = "v".repeat(43);
  const authInput = (extra = {}) =>
    authorizationInput({
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
    exchangeCode({ code, verifier, redirectUri, ...extra }, requestOrigin);
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
    // The Worker's storage outlives a suite, and other suites use alice too.
    await eraseSiteData("alice");
    await eraseSiteData("bob");
    owner = (
      await sql<{
        id: string;
      }>`insert into users(login_name) values ('alice') returning id`.execute(
        db,
      )
    ).rows[0].id;
    bob = (
      await sql<{
        id: string;
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
  test("the site and exact callback identify a registration; edits revoke grants", async () => {
    // An SDK released before sign-in dropped clientId still sends one. Any
    // value is ignored, a stale or foreign one included.
    const legacy = await approveAuthorization(
      owner,
      "alice-session",
      authInput({ clientId: "anything" }),
    );
    const legacyCode = new URL(legacy.redirect).searchParams.get("code")!;
    await expect(
      exchange(legacyCode, { clientId: "anything" }),
    ).resolves.toHaveProperty("accessToken");
    const callback2 = "https://alice.example/second.html";
    const second = await registerClient(owner, {
      redirectUri: callback2,
      collections: ["private"],
    });
    // Scope comes from the callback's own registration.
    await expect(
      approveAuthorization(
        owner,
        "alice-session",
        authInput({ redirectUri: callback2, collections: ["posts"] }),
      ),
    ).rejects.toMatchObject({ status: 403 });
    const response = await approveAuthorization(
      owner,
      "alice-session",
      authInput({ redirectUri: callback2, collections: ["private"] }),
    );
    const code = new URL(response.redirect).searchParams.get("code")!;
    // A code names its registration: the other callback cannot redeem it.
    await expect(exchange(code)).rejects.toMatchObject({ status: 401 });
    const grant = await exchange(code, { redirectUri: callback2 });
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
    await expect(data(grant.accessToken, ["private"])).rejects.toMatchObject({
      status: 401,
    });
    await removeClient(owner, second.id);
    await expect(exchange(await issue())).resolves.toHaveProperty(
      "accessToken",
    );
  });
  test("the consent page can register a page and create what it asks for", async () => {
    const page = "https://alice.example/editor.html";
    const input = authInput({
      redirectUri: page,
      collections: ["posts", "notes"],
    });
    expect(await authorizationSetup(owner, input)).toEqual({
      register: true,
      create: ["notes"],
      extend: [],
    });
    // Not the owner's to fix here: another account, or a page off the site.
    expect(await authorizationSetup(bob, input)).toBeNull();
    expect(
      await authorizationSetup(
        owner,
        authInput({ redirectUri: "https://evil.example/editor.html" }),
      ),
    ).toBeNull();
    await prepareAuthorization(owner, input);
    expect(await authorizationSetup(owner, input)).toBeNull();
    // A new collection starts private, as one made in the control panel does.
    expect(
      await listCollections({ id: owner, loginName: "alice" }, ["notes"]),
    ).toMatchObject([{ read_access: "admin", write_access: "admin" }]);
    const approved = await approveAuthorization(owner, "alice-session", input);
    const grant = await exchange(
      new URL(approved.redirect).searchParams.get("code")!,
      { redirectUri: page },
    );
    await expect(data(grant.accessToken, ["notes"])).resolves.toBeDefined();

    // Asking the same page for another collection extends its registration,
    // which signs out what it had issued, as editing it would.
    const wider = authInput({
      redirectUri: page,
      collections: ["posts", "notes", "private"],
    });
    expect(await authorizationSetup(owner, wider)).toEqual({
      register: false,
      create: [],
      extend: ["private"],
    });
    await prepareAuthorization(owner, wider);
    await expect(data(grant.accessToken, ["notes"])).rejects.toMatchObject({
      status: 401,
    });
    await expect(
      approveAuthorization(owner, "alice-session", wider),
    ).resolves.toHaveProperty("redirect");
    // Nothing is done for a request that was not the owner's to fix.
    await prepareAuthorization(
      bob,
      authInput({ redirectUri: page, collections: ["elsewhere"] }),
    );
    for (const site of [
      { id: owner, loginName: "alice" },
      { id: bob, loginName: "bob" },
    ])
      expect(await listCollections(site, ["elsewhere"])).toEqual([]);
  });
  test("every address of one page is one callback", async () => {
    // Naru serves /blog, /blog/ and /blog/index.html as the page /blog/.
    const page = await registerClient(owner, {
      redirectUri: "https://alice.example/blog/index.html",
      collections: ["posts"],
    });
    await expect(
      registerClient(owner, {
        redirectUri: "https://alice.example/blog",
        collections: ["posts"],
      }),
    ).rejects.toMatchObject({ status: 409 });
    const approved = await approveAuthorization(
      owner,
      "alice-session",
      authInput({ redirectUri: "https://alice.example/blog" }),
    );
    // Back to the address the sign-in left from, where its tab keeps the
    // pending sign-in, and exchanged from there.
    const redirect = new URL(approved.redirect);
    expect(redirect.origin + redirect.pathname).toBe(
      "https://alice.example/blog",
    );
    await expect(
      exchange(redirect.searchParams.get("code")!, {
        redirectUri: "https://alice.example/blog",
      }),
    ).resolves.toHaveProperty("accessToken");
    // A different file in that folder is a different page.
    await expect(
      approveAuthorization(
        owner,
        "alice-session",
        authInput({ redirectUri: "https://alice.example/blog/other.html" }),
      ),
    ).rejects.toMatchObject({ status: 403 });
    await removeClient(owner, page.id);
  });
  test("consent explains an unregistered page and a wrong account on Naru", async () => {
    const unregistered = "https://alice.example/unknown.html";
    await expect(
      approveAuthorization(
        owner,
        "alice-session",
        authInput({ redirectUri: unregistered }),
      ),
    ).rejects.toMatchObject({
      status: 403,
      message: expect.stringContaining(unregistered),
    });
    await expect(
      approveAuthorization(owner, "alice-session", authInput({ site: "bob" })),
    ).rejects.toMatchObject({
      status: 403,
      message: expect.stringContaining("bob 사이트"),
    });
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
  test("per-page lifetimes are bounded, snapshotted at consent, and shortening revokes grants", async () => {
    const uri = "https://alice.example/short.html";
    const page = await registerClient(owner, {
      redirectUri: uri,
      collections: ["posts"],
      tokenLifetimeSeconds: 120,
    });
    const input = (extra = {}) => authInput({ redirectUri: uri, ...extra });
    const code = async (extra = {}) =>
      new URL(
        (await approveAuthorization(owner, "alice-session", input(extra)))
          .redirect,
      ).searchParams.get("code")!;
    const redeem = (code: string, extra = {}) =>
      exchange(code, { redirectUri: uri, ...extra });
    const first = await redeem(await code(), { tokenLifetimeSeconds: 86400 });
    expect(first.expiresIn).toBeGreaterThan(115);
    expect(first.expiresIn).toBeLessThanOrEqual(120);
    const beforeIncrease = await code({ tokenLifetimeSeconds: 60 });
    await updateClient(owner, page.id, { tokenLifetimeSeconds: 300 });
    await expect(data(first.accessToken, ["posts"])).resolves.toBeDefined();
    expect(
      (
        await db
          .selectFrom("site_data_access_tokens")
          .select("expires_at")
          .where("hash", "=", digest(first.accessToken))
          .executeTakeFirstOrThrow()
      ).expires_at.getTime(),
    ).toBe(first.expiresAt);
    const approvedShort = await redeem(beforeIncrease);
    expect(approvedShort.expiresIn).toBeLessThanOrEqual(60);
    // A stale consent screen remains capped at the duration it displayed.
    const stale = await redeem(await code({ tokenLifetimeSeconds: 120 }));
    expect(stale.expiresIn).toBeLessThanOrEqual(120);
    const longer = await redeem(await code());
    expect(longer.expiresIn).toBeGreaterThan(295);
    const pending = await code();
    await updateClient(owner, page.id, {
      redirectUri: uri,
      collections: ["posts"],
      tokenLifetimeSeconds: 60,
    });
    await expect(data(longer.accessToken, ["posts"])).rejects.toMatchObject({
      status: 401,
    });
    await expect(redeem(pending)).rejects.toMatchObject({ status: 401 });
    const short = await redeem(await code({ tokenLifetimeSeconds: 86400 }));
    expect(short.expiresIn).toBeLessThanOrEqual(60);
    await expect(
      updateClient(bob, page.id, {
        redirectUri: uri,
        collections: ["posts"],
        tokenLifetimeSeconds: 60,
      }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      updateClient(owner, page.id, {
        redirectUri: uri,
        collections: ["posts"],
        tokenLifetimeSeconds: 86460,
      }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      sql`update site_data_clients set token_lifetime_seconds = 86460 where id = ${page.id}`.execute(
        db,
      ),
    ).rejects.toThrow();
    await removeClient(owner, page.id);
  });
  test("using a token renews it, bounded by the cap, the login and the page's lifetime", async () => {
    const uri = "https://alice.example/renewed.html";
    const page = await registerClient(owner, {
      redirectUri: uri,
      collections: ["posts"],
      tokenLifetimeSeconds: 120,
    });
    await db
      .updateTable("sessions")
      .set({ expires_at: new Date(Date.now() + 8 * 24 * 3600000) })
      .where("id", "=", "alice-session")
      .execute();
    const grant = await exchange(
      new URL(
        (
          await approveAuthorization(
            owner,
            "alice-session",
            authInput({ redirectUri: uri }),
          )
        ).redirect,
      ).searchParams.get("code")!,
      { redirectUri: uri },
      origin,
    );
    const hash = digest(grant.accessToken);
    const expiry = async () =>
      (
        await db
          .selectFrom("site_data_access_tokens")
          .select("expires_at")
          .where("hash", "=", hash)
          .executeTakeFirstOrThrow()
      ).expires_at.getTime();
    const backdate = (expiresIn: number, issuedAgo = 0) =>
      db
        .updateTable("site_data_access_tokens")
        .set({
          expires_at: new Date(Date.now() + expiresIn),
          issued_at: new Date(Date.now() - issuedAgo),
        })
        .where("hash", "=", hash)
        .execute();
    // A token still in the first half of its window is not rewritten.
    await expect(data(grant.accessToken, ["posts"])).resolves.toBeDefined();
    expect(await expiry()).toBe(grant.expiresAt);
    // Past halfway, the idle window starts again from this request.
    await backdate(30000);
    await expect(data(grant.accessToken, ["posts"])).resolves.toBeDefined();
    expect(await expiry()).toBeGreaterThan(Date.now() + 115000);
    expect(await expiry()).toBeLessThanOrEqual(Date.now() + 120000);
    // Never past seven days after the token was issued.
    await backdate(30000, 7 * 24 * 3600000 - 45000);
    await expect(data(grant.accessToken, ["posts"])).resolves.toBeDefined();
    expect(await expiry()).toBeLessThanOrEqual(Date.now() + 45000);
    expect(await expiry()).toBeGreaterThan(Date.now() + 30000);
    // Never past the Naru login the token hangs from.
    await backdate(30000);
    await db
      .updateTable("sessions")
      .set({ expires_at: new Date(Date.now() + 50000) })
      .where("id", "=", "alice-session")
      .execute();
    await expect(data(grant.accessToken, ["posts"])).resolves.toBeDefined();
    expect(await expiry()).toBeLessThanOrEqual(Date.now() + 50000);
    expect(await expiry()).toBeGreaterThan(Date.now() + 30000);
    // A bound that falls behind the expiry the token already has never
    // shortens it; only revocation and the deadline itself end a session.
    const before = await expiry();
    await db
      .updateTable("sessions")
      .set({ expires_at: new Date(Date.now() + 40000) })
      .where("id", "=", "alice-session")
      .execute();
    await expect(data(grant.accessToken, ["posts"])).resolves.toBeDefined();
    expect(await expiry()).toBe(before);
    await removeClient(owner, page.id);
    await db
      .updateTable("sessions")
      .set({ expires_at: new Date(Date.now() + 3600000) })
      .where("id", "=", "alice-session")
      .execute();
  });
  test("a token row written by code from before renewal is still usable", async () => {
    // What a traffic rollback would insert: the older code knows neither
    // column, so the schema has to answer for both or sign-in breaks.
    const legacy = "l".repeat(43);
    const [collection] = await listCollections(
      { id: owner, loginName: "alice" },
      ["posts"],
    );
    await sql`insert into site_data_access_tokens(hash,client_id,session_id,collection_ids,expires_at)
      values (${digest(legacy)},${registrationId},'alice-session',${[collection.id]},now() + interval '10 minutes')`.execute(
      db,
    );
    await expect(data(legacy, ["posts"])).resolves.toBeDefined();
    const stored = await db
      .selectFrom("site_data_access_tokens")
      .select(["lifetime_seconds", "issued_at"])
      .where("hash", "=", digest(legacy))
      .executeTakeFirstOrThrow();
    expect(stored.lifetime_seconds).toBe(86400);
    expect(stored.issued_at.getTime()).toBeLessThanOrEqual(Date.now());
    await revokeToken(legacy, origin);
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

test("token lifetime validation accepts whole minutes within platform bounds", () => {
  for (const value of [60, 3600, 86400])
    expect(tokenLifetime(value)).toBe(value);
  for (const value of [
    null,
    undefined,
    "60",
    0,
    -60,
    59,
    61,
    60.5,
    86460,
    Infinity,
    NaN,
  ])
    expect(() => tokenLifetime(value)).toThrow();
});
