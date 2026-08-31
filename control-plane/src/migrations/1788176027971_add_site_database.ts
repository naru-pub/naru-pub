import { Kysely, sql } from "kysely";

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable("site_data_collections")
    .addColumn("id", "serial", (c) => c.primaryKey())
    .addColumn("user_id", "integer", (c) =>
      c.notNull().references("users.id").onDelete("cascade"),
    )
    .addColumn("name", "text", (c) => c.notNull())
    .addColumn("read_access", "text", (c) => c.notNull().defaultTo("admin"))
    .addColumn("write_access", "text", (c) => c.notNull().defaultTo("admin"))
    .addUniqueConstraint("site_data_collection_name", ["user_id", "name"])
    .addCheckConstraint(
      "site_data_read_access",
      sql`read_access in ('world', 'admin')`,
    )
    .addCheckConstraint(
      "site_data_write_access",
      sql`write_access in ('world', 'admin')`,
    )
    .execute();
  await db.schema
    .createTable("site_data_documents")
    .addColumn("collection_id", "integer", (c) =>
      c.notNull().references("site_data_collections.id").onDelete("cascade"),
    )
    .addColumn("id", "text", (c) => c.notNull())
    .addColumn("data", "jsonb", (c) => c.notNull())
    .addColumn("size_bytes", "integer", (c) => c.notNull())
    .addColumn("updated_at", "timestamptz", (c) =>
      c.notNull().defaultTo(sql`now()`),
    )
    .addPrimaryKeyConstraint("site_data_document_pk", ["collection_id", "id"])
    .addCheckConstraint(
      "site_data_document_size",
      sql`size_bytes >= 0 and size_bytes <= 65536`,
    )
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable("site_data_documents").execute();
  await db.schema.dropTable("site_data_collections").execute();
}
