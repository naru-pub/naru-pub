import { sql, type Kysely } from "kysely";

export async function up(db: Kysely<any>): Promise<void> {
  // Deliberately no CASCADE: any unexpected database dependency must block the
  // migration rather than silently remove an object. The legacy UUID helpers
  // were left behind when their legacy_ids table was removed.
  await sql`drop function erase_account_content(uuid)`.execute(db);
  await sql`drop function legacy_uuid_array(text, bigint[])`.execute(db);
  await sql`drop function legacy_uuid(text, bigint)`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DO $$ BEGIN RAISE EXCEPTION 'Deploy a forward fix; account content deletion now runs in TypeScript'; END $$`.execute(
    db,
  );
}
