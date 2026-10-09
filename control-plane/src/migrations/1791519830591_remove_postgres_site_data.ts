import { sql, type Kysely } from "kysely";

// Every site's collections and documents now live in its Durable Object, so
// PostgreSQL's copies, the usage triggers that counted them and the per-site
// store column go. Breaking: deploy with DEPLOY_DOWNTIME=1.
//
// Refuses to run while any site still has collections here that were never
// moved (site_data_backend other than durable_object): those would be lost.
// Move them with site-data-move from the previous release first.
//
// users.site_data_document_count and site_data_bytes_used stay, as plain
// columns: the site-data-edge-sync job copies each object's usage into them.
export async function up(db: Kysely<any>): Promise<void> {
  const { rows } = await sql<{ login_name: string }>`
    select distinct u.login_name from site_data_collections c
    join users u on u.id = c.user_id
    where u.site_data_backend <> 'durable_object'
  `.execute(db);
  if (rows.length)
    throw new Error(
      `Site data still in PostgreSQL for: ${rows.map((r) => r.login_name).join(", ")}. Move these sites first.`,
    );
  await sql`drop trigger site_data_usage_collection_delete on site_data_collections`.execute(
    db,
  );
  await sql`drop function site_data_usage_collection_delete()`.execute(db);
  for (const event of ["insert", "delete", "update"]) {
    await sql
      .raw(`drop trigger site_data_usage_${event} on site_data_documents`)
      .execute(db);
    await sql.raw(`drop function site_data_usage_${event}()`).execute(db);
  }
  await sql`drop table site_data_documents, site_data_collections, site_data_rate_limits`.execute(
    db,
  );
  await sql`alter table users drop column site_data_backend`.execute(db);
}

export async function down(): Promise<void> {
  throw new Error(
    "Irreversible: the site data is in Durable Objects. Restore the tables from the pg_dump taken before this migration if needed.",
  );
}
