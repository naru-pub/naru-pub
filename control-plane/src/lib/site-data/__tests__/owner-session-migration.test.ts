/** @jest-environment node */
import { afterAll, beforeAll, describe, expect, test } from "@jest/globals";
import { sql } from "kysely";
import { db } from "@/lib/database";
import {
  up,
  down,
} from "@/migrations/1788206726527_stable_site_clients_and_owner_sessions";
import { setupTestDatabase, teardownTestDatabase } from "./test-database";
import {
  approveAuthorization,
  authorizationInput,
  digest,
  exchangeCode,
  siteClientId,
} from "../owner-auth";

const integration =
  process.env.NARU_DATA_TEST === "1" ? describe : describe.skip;
integration("stable client and owner session migration", () => {
  let ready = false;
  beforeAll(async () => {
    await setupTestDatabase();
    ready = true;
  });
  afterAll(async () => {
    if (ready) await teardownTestDatabase();
    await db.destroy();
  });
  test("preserves registered callbacks but invalidates old grants; rollback revokes sessions", async () => {
    await down(db);
    const owner = (
      await sql<{
        id: number;
      }>`insert into users(login_name) values ('migrate') returning id`.execute(
        db,
      )
    ).rows[0].id;
    await sql`insert into sessions values ('parent',${owner},now()+interval '12 hours')`.execute(
      db,
    );
    await sql`insert into site_data_collections(user_id,name) values (${owner},'posts')`.execute(
      db,
    );
    const collection = await db
      .selectFrom("site_data_collections")
      .select("id")
      .where("user_id", "=", owner)
      .executeTakeFirstOrThrow();
    const redirectUri = "http://localhost/admin.html";
    for (const [id, uri] of [
      ["legacy-a", redirectUri],
      ["legacy-b", "http://localhost/second.html"],
    ]) {
      await sql`insert into site_data_clients(id,user_id,redirect_uri,collection_ids) values (${id},${owner},${uri},${[collection.id]})`.execute(
        db,
      );
    }
    await sql`insert into site_data_access_tokens(hash,client_id,session_id,collection_ids,expires_at) values ('legacy-token','legacy-a','parent',${[collection.id]},now()+interval '10 minutes')`.execute(
      db,
    );
    await sql`insert into site_data_auth_codes(hash,client_id,session_id,collection_ids,expires_at,challenge) values ('legacy-code','legacy-b','parent',${[collection.id]},now()+interval '1 minute','challenge')`.execute(
      db,
    );
    await up(db);
    const stable = await siteClientId(owner);
    expect(
      await db
        .selectFrom("site_data_site_clients")
        .selectAll()
        .where("user_id", "=", owner)
        .execute(),
    ).toHaveLength(1);
    expect(
      await db.selectFrom("site_data_clients").selectAll().execute(),
    ).toHaveLength(2);
    expect(
      await db.selectFrom("site_data_access_tokens").select("hash").execute(),
    ).toEqual([]);
    expect(
      await db.selectFrom("site_data_auth_codes").select("hash").execute(),
    ).toEqual([]);
    const verifier = "v".repeat(43);
    const response = await approveAuthorization(
      owner,
      "parent",
      authorizationInput({
        site: "migrate",
        clientId: stable,
        redirectUri,
        collections: ["posts"],
        challenge: digest(verifier),
        state: "s".repeat(43),
      }),
    );
    const grant = await exchangeCode(
      {
        code: new URL(response.redirect).searchParams.get("code"),
        verifier,
        clientId: stable,
        redirectUri,
      },
      "http://localhost",
    );
    expect(grant).toHaveProperty("accessToken");
    await down(db);
    expect(
      (await sql`select hash from site_data_access_tokens`.execute(db)).rows,
    ).toEqual([]);
    expect(
      await db.selectFrom("site_data_clients").selectAll().execute(),
    ).toHaveLength(2);
    await up(db);
  });
});
