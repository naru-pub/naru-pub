import { down as uuidDown } from "@/migrations/1791346354414_site_data_uuid_columns";
/** @jest-environment node */
import { afterAll, beforeAll, describe, expect, test } from "@jest/globals";
import { sql } from "kysely";
import { db } from "@/lib/database";
import {
  up,
  down,
} from "@/migrations/1788206726527_stable_site_clients_and_owner_sessions";
import {
  up as dropSiteClients,
  down as restoreSiteClients,
} from "@/migrations/1790078516190_drop_site_data_site_clients";
import { setupTestDatabase, teardownTestDatabase } from "./test-database";

const integration =
  process.env.NARU_DATA_TEST === "1" ? describe : describe.skip;
integration("stable client and owner session migration", () => {
  let ready = false;
  beforeAll(async () => {
    // The PostgreSQL collections this migration ran against.
    await setupTestDatabase({ postgresSiteData: true });
    ready = true;
  });
  afterAll(async () => {
    if (ready) await teardownTestDatabase();
    await db.destroy();
  });
  test("preserves registered callbacks but invalidates old grants; rollback revokes sessions", async () => {
    await uuidDown(db);
    // Step back past the later drop of the table this migration created.
    await restoreSiteClients(db);
    await down(db);
    const owner = (
      await sql<{
        id: string;
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
    const collection = (
      await sql<{
        id: string;
      }>`select id from site_data_collections where user_id = ${owner}`.execute(
        db,
      )
    ).rows[0];
    const redirectUri = "http://localhost/admin.html";
    for (const [id, uri] of [
      ["legacy-a", redirectUri],
      ["legacy-b", "http://localhost/second.html"],
    ]) {
      await sql`insert into site_data_clients(id,user_id,redirect_uri,collection_ids) values (${id},${owner},${uri},${[collection.id]})`.execute(
        db,
      );
    }
    // lifetime_seconds is newer than the migration under test; a token from
    // before it exists only to be invalidated here.
    await sql`insert into site_data_access_tokens(hash,client_id,session_id,collection_ids,expires_at,lifetime_seconds) values ('legacy-token','legacy-a','parent',${[collection.id]},now()+interval '10 minutes',600)`.execute(
      db,
    );
    await sql`insert into site_data_auth_codes(hash,client_id,session_id,collection_ids,expires_at,challenge) values ('legacy-code','legacy-b','parent',${[collection.id]},now()+interval '1 minute','challenge')`.execute(
      db,
    );
    await up(db);
    expect(
      await db.selectFrom("site_data_clients").selectAll().execute(),
    ).toHaveLength(2);
    expect(
      await db.selectFrom("site_data_access_tokens").select("hash").execute(),
    ).toEqual([]);
    expect(
      await db.selectFrom("site_data_auth_codes").select("hash").execute(),
    ).toEqual([]);
    // A grant issued after the migration, which rolling it back revokes.
    // (Issued directly: sign-in code reads collections from Durable Objects,
    // which this schema from before them does not name the same way.)
    const client = await db
      .selectFrom("site_data_clients")
      .select("id")
      .executeTakeFirstOrThrow();
    await sql`insert into site_data_access_tokens(hash,client_id,session_id,collection_ids,expires_at)
      values ('after-migration',${client.id},'parent',${[collection.id]},now()+interval '10 minutes')`.execute(
      db,
    );
    await down(db);
    expect(
      (await sql`select hash from site_data_access_tokens`.execute(db)).rows,
    ).toEqual([]);
    expect(
      await db.selectFrom("site_data_clients").selectAll().execute(),
    ).toHaveLength(2);
    await up(db);
    await dropSiteClients(db);
  });
  test("the site client table drops and comes back empty", async () => {
    const exists = async () =>
      (
        await sql<{
          name: string | null;
        }>`select to_regclass('site_data_site_clients') as name`.execute(db)
      ).rows[0].name !== null;
    expect(await exists()).toBe(false);
    await restoreSiteClients(db);
    expect(await exists()).toBe(true);
    await dropSiteClients(db);
    expect(await exists()).toBe(false);
  });
});
