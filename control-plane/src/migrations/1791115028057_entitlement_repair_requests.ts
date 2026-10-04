import { sql, type Kysely } from "kysely";

export async function up(db: Kysely<any>): Promise<void> {
  await sql`create table entitlement_repairs (
    id uuid primary key default uuid_v7(),
    user_id uuid not null references users(id) on delete restrict,
    operator_id uuid not null references users(id) on delete restrict,
    operator_login_name text not null,
    reason text not null check (length(btrim(reason)) between 1 and 200),
    status text not null default 'pending' check (status in ('pending', 'completed', 'skipped')),
    created_at timestamptz not null default now(),
    completed_at timestamptz,
    before_until timestamptz,
    after_until timestamptz,
    result_note text,
    changed_payment_ids uuid[] not null default '{}',
    check ((status = 'pending') = (completed_at is null))
  )`.execute(db);
  await sql`create unique index entitlement_repairs_one_pending_idx
    on entitlement_repairs(user_id) where completed_at is null`.execute(db);
}

export async function down(_db: Kysely<any>): Promise<void> {
  throw new Error(
    "Deploy a forward fix; preserve entitlement repair requests and audit history",
  );
}
