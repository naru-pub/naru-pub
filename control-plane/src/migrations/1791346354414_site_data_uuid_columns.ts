import { sql, type Kysely } from "kysely";

// Preserve existing v4/v7 identities, file object keys, and active grants.
// A non-UUID legacy value aborts the migration rather than being replaced.
const GRANTS = ["site_data_auth_codes", "site_data_access_tokens"] as const;

async function convert(db: Kysely<any>, toUuid: boolean): Promise<void> {
  for (const table of GRANTS) {
    await sql
      .raw(`alter table ${table} drop constraint ${table}_client_id_fkey`)
      .execute(db);
  }
  await sql
    .raw(
      `alter table site_data_clients alter column id type ${toUuid ? "uuid using id::uuid" : "text using id::text"}`,
    )
    .execute(db);
  for (const table of GRANTS) {
    await sql
      .raw(
        `alter table ${table} alter column client_id type ${toUuid ? "uuid using client_id::uuid" : "text using client_id::text"}`,
      )
      .execute(db);
    await sql
      .raw(
        `alter table ${table} add constraint ${table}_client_id_fkey foreign key (client_id) references site_data_clients(id) on delete cascade`,
      )
      .execute(db);
  }
  await sql
    .raw(
      `alter table site_data_files alter column id type ${toUuid ? "uuid using id::uuid" : "varchar(64) using id::text"}`,
    )
    .execute(db);
}

export async function up(db: Kysely<any>): Promise<void> {
  await convert(db, true);
}

export async function down(db: Kysely<any>): Promise<void> {
  await convert(db, false);
}
