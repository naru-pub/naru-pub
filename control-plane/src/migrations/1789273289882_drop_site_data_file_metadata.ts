import type { Kysely } from "kysely";
import { sql } from "kysely";

// `any` is required here since migrations should be frozen in time. alternatively, keep a "snapshot" db interface.
export async function up(db: Kysely<any>): Promise<void> {
  // Naru no longer records what a file belongs to. The code that stopped
  // writing and reading this column shipped in an earlier deploy, so the slot
  // still serving while this runs never touches it.
  await sql`drop index if exists site_data_files_metadata_idx`.execute(db);
  await db.schema
    .alterTable("site_data_files")
    .dropColumn("metadata")
    .execute();
}

// `any` is required here since migrations should be frozen in time. alternatively, keep a "snapshot" db interface.
export async function down(db: Kysely<any>): Promise<void> {
  // Restores the shape only; the metadata that was stored is gone.
  await db.schema
    .alterTable("site_data_files")
    .addColumn("metadata", "jsonb", (column) =>
      column.notNull().defaultTo(sql`'{}'::jsonb`),
    )
    .execute();
  await sql`create index site_data_files_metadata_idx on site_data_files using gin (metadata jsonb_path_ops)`.execute(
    db,
  );
}
