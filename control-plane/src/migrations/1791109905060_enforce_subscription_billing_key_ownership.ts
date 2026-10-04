import { sql, type Kysely } from "kysely";

export async function up(db: Kysely<any>): Promise<void> {
  // Include ownership and status in the referenced identity. PostgreSQL's FK
  // locking protects assignment against concurrent ownership/status changes.
  await sql`alter table billing_keys add constraint billing_keys_identity_owner_status_key
    unique (id, user_id, status)`.execute(db);
  await sql`alter table subscriptions
    add column billing_key_required_status text generated always as ('active'::text) stored,
    add constraint subscriptions_active_owned_key_fkey
      foreign key (billing_key_id, user_id, billing_key_required_status)
      references billing_keys (id, user_id, status)
      on update restrict on delete restrict,
    drop constraint subscriptions_billing_key_id_fkey`.execute(db);
  await sql`drop trigger billing_keys_held_are_active on billing_keys`.execute(
    db,
  );
  await sql`drop function subscription_key_is_active()`.execute(db);
}

export async function down(_db: Kysely<any>): Promise<void> {
  throw new Error(
    "Deploy a forward fix; retain billing-key ownership and activity invariants",
  );
}
