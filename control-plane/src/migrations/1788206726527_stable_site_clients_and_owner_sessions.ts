import { randomUUID } from "node:crypto";
import { Kysely } from "kysely";

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable("site_data_site_clients")
    .addColumn("user_id", "integer", (c) =>
      c.primaryKey().references("users.id").onDelete("cascade"),
    )
    .addColumn("id", "text", (c) => c.notNull().unique())
    .execute();
  // Callback rows remain internal registration IDs, not public Client IDs.
  // All website sessions must sign in again using the new shared website ID.
  await db.deleteFrom("site_data_auth_codes").execute();
  await db.deleteFrom("site_data_access_tokens").execute();
  const owners = await db
    .selectFrom("site_data_clients")
    .select("user_id")
    .distinct()
    .execute();
  for (const owner of owners) {
    await db
      .insertInto("site_data_site_clients")
      .values({ user_id: owner.user_id, id: randomUUID() })
      .execute();
  }
}
export async function down(db: Kysely<any>): Promise<void> {
  // Revoke grants on rollback; keep registered URLs and collection permissions.
  await db.deleteFrom("site_data_auth_codes").execute();
  await db.deleteFrom("site_data_access_tokens").execute();
  await db.schema.dropTable("site_data_site_clients").execute();
}
