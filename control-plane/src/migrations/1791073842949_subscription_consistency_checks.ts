import { sql, type Kysely } from "kysely";

export async function up(db: Kysely<any>): Promise<void> {
  await sql`alter table subscriptions
    add constraint subscriptions_canceled_without_billing
      check (status <> 'canceled' or (billing_key_id is null and next_billing_at is null)),
    add constraint subscriptions_running_with_billing
      check (status not in ('active', 'scheduled') or (billing_key_id is not null and next_billing_at is not null))`.execute(
    db,
  );
  await sql`drop trigger subscriptions_key_matches_status on subscriptions`.execute(
    db,
  );
  await sql`drop function subscription_key_matches_status()`.execute(db);
}

export async function down(_db: Kysely<any>): Promise<void> {
  throw new Error(
    "Deploy a forward fix; subscription writes now satisfy immediate checks",
  );
}
