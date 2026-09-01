import type { Kysely } from "kysely";
import { sql } from "kysely";

// `any` is required here since migrations should be frozen in time. alternatively, keep a "snapshot" db interface.
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable("site_data_files")
    .addColumn("metadata", "jsonb", (column) =>
      column.notNull().defaultTo(sql`'{}'::jsonb`),
    )
    .execute();
}

// `any` is required here since migrations should be frozen in time. alternatively, keep a "snapshot" db interface.
export async function down(db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable("site_data_files")
    .dropColumn("metadata")
    .execute();
}
