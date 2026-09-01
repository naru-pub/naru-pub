import type { Kysely } from "kysely";
import { sql } from "kysely";

// `any` is required here since migrations should be frozen in time. alternatively, keep a "snapshot" db interface.
export async function up(db: Kysely<any>): Promise<void> {
  // Existing documents start at 1, so a conditional write quoting a version
  // read before this migration can never match by accident.
  await db.schema
    .alterTable("site_data_documents")
    .addColumn("version", "integer", (column) =>
      column.notNull().defaultTo(sql`1`),
    )
    .execute();
}

// `any` is required here since migrations should be frozen in time. alternatively, keep a "snapshot" db interface.
export async function down(db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable("site_data_documents")
    .dropColumn("version")
    .execute();
}
