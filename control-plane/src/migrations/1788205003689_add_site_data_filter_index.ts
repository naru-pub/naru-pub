import { Kysely, sql } from "kysely";

export async function up(db: Kysely<any>): Promise<void> {
  // Shared automatic index: no user-controlled SQL or per-field DDL.
  await sql`create index site_data_documents_data_idx on site_data_documents using gin (data jsonb_path_ops)`.execute(
    db,
  );
}
export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropIndex("site_data_documents_data_idx").execute();
}
