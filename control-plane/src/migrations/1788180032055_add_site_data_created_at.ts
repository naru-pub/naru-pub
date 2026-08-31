import { Kysely, sql } from "kysely";

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable("site_data_documents")
    .addColumn("created_at", "timestamptz")
    .execute();
  // The original creation time was not recorded; preserve the best available timestamp.
  await sql`update site_data_documents set created_at = updated_at`.execute(db);
  await db.schema
    .alterTable("site_data_documents")
    .alterColumn("created_at", (c) => c.setDefault(sql`now()`))
    .execute();
  await db.schema
    .alterTable("site_data_documents")
    .alterColumn("created_at", (c) => c.setNotNull())
    .execute();
  for (const field of ["created_at", "updated_at"]) {
    await db.schema
      .createIndex(`site_data_documents_${field}_idx`)
      .on("site_data_documents")
      .columns(["collection_id", field, "id"])
      .execute();
  }
}

export async function down(db: Kysely<any>): Promise<void> {
  for (const field of ["created_at", "updated_at"]) {
    await db.schema.dropIndex(`site_data_documents_${field}_idx`).execute();
  }
  await db.schema
    .alterTable("site_data_documents")
    .dropColumn("created_at")
    .execute();
}
