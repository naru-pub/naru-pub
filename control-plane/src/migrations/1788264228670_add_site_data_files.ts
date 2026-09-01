import type { Kysely } from "kysely";
import { sql } from "kysely";

// `any` is required here since migrations should be frozen in time. alternatively, keep a "snapshot" db interface.
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable("site_data_files")
    .addColumn("id", "varchar(64)", (column) => column.primaryKey())
    .addColumn("user_id", "integer", (column) =>
      column.notNull().references("users.id").onDelete("cascade"),
    )
    .addColumn("object_key", "text", (column) => column.notNull().unique())
    .addColumn("original_name", "text", (column) => column.notNull())
    .addColumn("content_type", "text", (column) => column.notNull())
    .addColumn("size_bytes", "integer", (column) => column.notNull())
    .addColumn("status", "text", (column) =>
      column.notNull().defaultTo("pending"),
    )
    .addColumn("created_at", "timestamptz", (column) =>
      column.notNull().defaultTo(sql`now()`),
    )
    .addColumn("updated_at", "timestamptz", (column) =>
      column.notNull().defaultTo(sql`now()`),
    )
    .addCheckConstraint(
      "site_data_file_size",
      sql`size_bytes >= 1 and size_bytes <= 26214400`,
    )
    .addCheckConstraint(
      "site_data_file_status",
      sql`status in ('pending', 'ready')`,
    )
    .execute();
  await db.schema
    .createIndex("site_data_files_user_created_idx")
    .on("site_data_files")
    .columns(["user_id", "created_at"])
    .execute();
}

// `any` is required here since migrations should be frozen in time. alternatively, keep a "snapshot" db interface.
export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable("site_data_files").execute();
}
