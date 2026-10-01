import { sql, type Kysely } from "kysely";

// legacy_ids kept each table's old sequence numbers after 1790824144110, for
// the storage keys built from them. Template files were copied to their new
// ids (copy-legacy-template-storage) and media moved to their user's id
// (move-legacy-media-keys), so nothing reads it any more.
//
// down recreates the table empty: the old numbers are gone, so reverting
// 1790824144110 past this point fails rather than inventing them.
// `any` is required here since migrations should be frozen in time.
export async function up(db: Kysely<any>): Promise<void> {
  await sql`drop table legacy_ids`.execute(db);
}

// `any` is required here since migrations should be frozen in time.
export async function down(db: Kysely<any>): Promise<void> {
  await sql`
    create table legacy_ids (
      table_name text not null,
      old_id bigint not null,
      new_id uuid not null unique,
      primary key (table_name, old_id)
    )
  `.execute(db);
}
