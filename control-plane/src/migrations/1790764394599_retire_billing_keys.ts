import { sql, type Kysely } from "kysely";

// Billing keys never expire at Toss and are stored here in plain text. A key
// that 나루 stops using — a canceled, refunded or replaced subscription, or a
// deleted account — must also be deleted at Toss, or it stays chargeable for
// as long as anyone holds it together with the billing secret key.
//
// A trigger queues every key that leaves subscriptions.toss_billing_key, so no
// code path that clears or replaces a key (or deletes the row) can forget to.
// lib/payments/billing-keys.ts deletes queued keys at Toss and drops the row once Toss
// confirms, so the plain-text copy does not outlive the key itself.
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable("retired_billing_keys")
    .addColumn("id", "serial", (col) => col.primaryKey())
    .addColumn("billing_key", "text", (col) => col.notNull().unique())
    .addColumn("retired_at", "timestamptz", (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .addColumn("attempts", "integer", (col) => col.notNull().defaultTo(0))
    .addColumn("last_attempted_at", "timestamptz")
    .addColumn("last_error", "text")
    .execute();

  await sql`
    create function queue_retired_billing_key() returns trigger
    language plpgsql as $$
    begin
      if old.toss_billing_key is not null
        and (tg_op = 'DELETE'
          or new.toss_billing_key is distinct from old.toss_billing_key) then
        insert into retired_billing_keys (billing_key)
        values (old.toss_billing_key)
        on conflict (billing_key) do nothing;
      end if;
      return null;
    end;
    $$
  `.execute(db);

  await sql`
    create trigger subscriptions_retire_billing_key
    after update of toss_billing_key or delete on subscriptions
    for each row execute function queue_retired_billing_key()
  `.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`drop trigger subscriptions_retire_billing_key on subscriptions`.execute(
    db,
  );
  await sql`drop function queue_retired_billing_key()`.execute(db);
  await db.schema.dropTable("retired_billing_keys").execute();
}
