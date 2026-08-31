import { Kysely, sql } from "kysely";

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable("site_data_collections")
    .dropConstraint("site_data_write_access")
    .execute();
  await db.schema
    .alterTable("site_data_collections")
    .addCheckConstraint(
      "site_data_write_access",
      sql`write_access in ('world', 'create', 'admin')`,
    )
    .execute();
  await db.schema
    .createTable("site_data_clients")
    .addColumn("id", "text", (c) => c.primaryKey())
    .addColumn("user_id", "integer", (c) =>
      c.notNull().references("users.id").onDelete("cascade"),
    )
    .addColumn("redirect_uri", "text", (c) => c.notNull())
    .addColumn("collection_ids", sql`integer[]`, (c) => c.notNull())
    .addColumn("created_at", "timestamptz", (c) =>
      c.notNull().defaultTo(sql`now()`),
    )
    .addUniqueConstraint("site_data_client_redirect", [
      "user_id",
      "redirect_uri",
    ])
    .execute();
  for (const table of ["site_data_auth_codes", "site_data_access_tokens"]) {
    let query = db.schema
      .createTable(table)
      .addColumn("hash", "text", (c) => c.primaryKey())
      .addColumn("client_id", "text", (c) =>
        c.notNull().references("site_data_clients.id").onDelete("cascade"),
      )
      .addColumn("session_id", "text", (c) =>
        c.notNull().references("sessions.id").onDelete("cascade"),
      )
      .addColumn("collection_ids", sql`integer[]`, (c) => c.notNull())
      .addColumn("expires_at", "timestamptz", (c) => c.notNull());
    if (table === "site_data_auth_codes")
      query = query.addColumn("challenge", "text", (c) => c.notNull());
    await query.execute();
    await db.schema
      .createIndex(`${table}_client_idx`)
      .on(table)
      .column("client_id")
      .execute();
    await db.schema
      .createIndex(`${table}_session_idx`)
      .on(table)
      .column("session_id")
      .execute();
    await db.schema
      .createIndex(`${table}_expiry_idx`)
      .on(table)
      .column("expires_at")
      .execute();
  }
  await db.schema
    .createTable("site_data_rate_limits")
    .addColumn("user_id", "integer", (c) =>
      c.notNull().references("users.id").onDelete("cascade"),
    )
    .addColumn("key", "text", (c) => c.notNull())
    .addColumn("window_start", "timestamptz", (c) => c.notNull())
    .addColumn("count", "integer", (c) => c.notNull())
    .addPrimaryKeyConstraint("site_data_rate_limits_pk", ["user_id", "key"])
    .execute();
  await db.schema
    .createIndex("site_data_rate_limits_window_idx")
    .on("site_data_rate_limits")
    .column("window_start")
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable("site_data_rate_limits").execute();
  await db.schema.dropTable("site_data_access_tokens").execute();
  await db.schema.dropTable("site_data_auth_codes").execute();
  await db.schema.dropTable("site_data_clients").execute();
  // Fail closed when reverting a permission the old implementation cannot read.
  await sql`update site_data_collections set write_access = 'admin' where write_access = 'create'`.execute(
    db,
  );
  await db.schema
    .alterTable("site_data_collections")
    .dropConstraint("site_data_write_access")
    .execute();
  await db.schema
    .alterTable("site_data_collections")
    .addCheckConstraint(
      "site_data_write_access",
      sql`write_access in ('world', 'admin')`,
    )
    .execute();
}
