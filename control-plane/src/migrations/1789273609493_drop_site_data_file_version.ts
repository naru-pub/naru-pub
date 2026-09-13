import type { Kysely } from "kysely";

// `any` is required here since migrations should be frozen in time. alternatively, keep a "snapshot" db interface.
export async function up(db: Kysely<any>): Promise<void> {
  // The version guarded metadata edits, which no longer exist. No running code
  // writes or reads it, so this is safe while the previous slot still serves.
  await db.schema.alterTable("site_data_files").dropColumn("version").execute();
}

// `any` is required here since migrations should be frozen in time. alternatively, keep a "snapshot" db interface.
export async function down(db: Kysely<any>): Promise<void> {
  // Every file had been written exactly once as far as this column knew.
  await db.schema
    .alterTable("site_data_files")
    .addColumn("version", "integer", (column) => column.notNull().defaultTo(1))
    .execute();
}
