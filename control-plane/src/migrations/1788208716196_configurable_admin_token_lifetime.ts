import { Kysely, sql } from "kysely";

export async function up(db: Kysely<any>): Promise<void> {
  for (const table of ["site_data_clients", "site_data_auth_codes"]) {
    await db.schema
      .alterTable(table)
      .addColumn("token_lifetime_seconds", "integer", (c) =>
        c.notNull().defaultTo(86400),
      )
      .execute();
    await db.schema
      .alterTable(table)
      .addCheckConstraint(
        `${table}_token_lifetime`,
        sql`token_lifetime_seconds between 60 and 86400 and token_lifetime_seconds % 60 = 0`,
      )
      .execute();
  }
}
export async function down(db: Kysely<any>): Promise<void> {
  // Reverting to a fixed lifetime must not widen an outstanding shorter grant.
  await db.deleteFrom("site_data_auth_codes").execute();
  await db.deleteFrom("site_data_access_tokens").execute();
  for (const table of ["site_data_auth_codes", "site_data_clients"]) {
    await db.schema
      .alterTable(table)
      .dropColumn("token_lifetime_seconds")
      .execute();
  }
}
