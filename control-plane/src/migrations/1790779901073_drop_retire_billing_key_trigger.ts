import { sql, type Kysely } from "kysely";

// Retiring a billing key is done in application code now (retireBillingKey in
// lib/billing-keys.ts, deleteUserRow in lib/account-deletion.ts), guarded by
// billing-key-writes-payment.test.ts. The trigger that did the same in the
// database is dropped; retired_billing_keys stays as the queue both use.
//
// Deploy only after the code that retires keys itself is live: migrations run
// before traffic switches, and older code relies on this trigger.
export async function up(db: Kysely<any>): Promise<void> {
  await sql`drop trigger subscriptions_retire_billing_key on subscriptions`.execute(
    db,
  );
  await sql`drop function queue_retired_billing_key()`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
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
