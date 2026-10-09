/** @jest-environment node */
import { afterAll, beforeAll, describe, expect, test } from "@jest/globals";
import { sql } from "kysely";
import { db } from "@/lib/database";
import { up, down } from "@/migrations/1791346354414_site_data_uuid_columns";
import { setupTestDatabase, teardownTestDatabase } from "./test-database";
import { uuidId } from "../validation";

const integration =
  process.env.NARU_DATA_TEST === "1" ? describe : describe.skip;
integration("site-data UUID column migration", () => {
  // The PostgreSQL collections this migration ran against.
  beforeAll(() => setupTestDatabase({ postgresSiteData: true }));
  afterAll(async () => {
    await teardownTestDatabase();
    await db.destroy();
  });
  test("preserves v4/v7 IDs, grants and object keys through conversion and rollback", async () => {
    await down(db);
    const owner = (
      await sql<{
        id: string;
      }>`insert into users(login_name) values ('uuid-owner') returning id`.execute(
        db,
      )
    ).rows[0].id;
    await sql`insert into sessions values ('uuid-session', ${owner}, now() + interval '1 day')`.execute(
      db,
    );
    const ids = [
      "550e8400-e29b-41d4-a716-446655440000",
      "01930000-0000-7000-8000-000000000001",
    ];
    for (const id of ids) {
      await sql`insert into site_data_clients(id,user_id,redirect_uri,collection_ids) values (${id},${owner},${`https://example.com/${id}`},'{}')`.execute(
        db,
      );
      await sql`insert into site_data_auth_codes(hash,client_id,session_id,collection_ids,expires_at,challenge) values (${id},${id},'uuid-session','{}',now()+interval '1 day','challenge')`.execute(
        db,
      );
      await sql`insert into site_data_access_tokens(hash,client_id,session_id,collection_ids,expires_at,lifetime_seconds) values (${id},${id},'uuid-session','{}',now()+interval '1 day',600)`.execute(
        db,
      );
      await sql`insert into site_data_files(id,user_id,object_key,original_name,content_type,size_bytes) values (${id},${owner},${`old-prefix/${id}.png`},'image.png','image/png',1)`.execute(
        db,
      );
    }
    await db.transaction().execute(up);
    const types = (
      await sql<{
        data_type: string;
      }>`select data_type from information_schema.columns where table_schema='public' and ((table_name in ('site_data_clients','site_data_files') and column_name='id') or (table_name in ('site_data_auth_codes','site_data_access_tokens') and column_name='client_id'))`.execute(
        db,
      )
    ).rows;
    expect(types).toHaveLength(4);
    expect(types.every((row) => row.data_type === "uuid")).toBe(true);
    expect(
      (
        await db
          .selectFrom("site_data_files")
          .select(["id", "object_key"])
          .orderBy("id")
          .execute()
      ).map((row) => row.object_key),
    ).toEqual([...ids].sort().map((id) => `old-prefix/${id}.png`));
    for (const table of [
      "site_data_auth_codes",
      "site_data_access_tokens",
    ] as const) {
      expect(
        (await db.selectFrom(table).select("client_id").execute())
          .map((row) => row.client_id)
          .sort(),
      ).toEqual([...ids].sort());
    }
    await db.deleteFrom("site_data_clients").where("id", "=", ids[0]).execute();
    expect(
      await db
        .selectFrom("site_data_access_tokens")
        .select("hash")
        .where("hash", "=", ids[0])
        .execute(),
    ).toEqual([]);
    await db.transaction().execute(down);
    expect(
      (await db.selectFrom("site_data_files").select("id").execute())
        .map((row) => row.id)
        .sort(),
    ).toEqual([...ids].sort());
    await db.transaction().execute(up);
  });
  test("rolls back without losing data when a legacy ID is not a UUID", async () => {
    await down(db);
    const owner = await db
      .selectFrom("users")
      .select("id")
      .where("login_name", "=", "uuid-owner")
      .executeTakeFirstOrThrow();
    await sql`insert into site_data_clients(id,user_id,redirect_uri,collection_ids) values ('legacy-invalid',${owner.id},'https://example.com/invalid','{}')`.execute(
      db,
    );
    await expect(db.transaction().execute(up)).rejects.toThrow(/uuid/i);
    expect(
      await db
        .selectFrom("site_data_clients")
        .select("id")
        .where("id", "=", "legacy-invalid")
        .executeTakeFirst(),
    ).toEqual({ id: "legacy-invalid" });
    const type = (
      await sql<{
        data_type: string;
      }>`select data_type from information_schema.columns where table_schema='public' and table_name='site_data_clients' and column_name='id'`.execute(
        db,
      )
    ).rows[0];
    expect(type.data_type).toBe("text");
    await db
      .deleteFrom("site_data_clients")
      .where("id", "=", "legacy-invalid")
      .execute();
    await db.transaction().execute(up);
  });
  test("rejects malformed request IDs and accepts both UUID versions", () => {
    expect(() => uuidId("invalid")).toThrow("Invalid UUID identifier.");
    expect(uuidId("550E8400-E29B-41D4-A716-446655440000")).toBe(
      "550e8400-e29b-41d4-a716-446655440000",
    );
    expect(uuidId("01930000-0000-7000-8000-000000000001")).toBe(
      "01930000-0000-7000-8000-000000000001",
    );
  });
});
