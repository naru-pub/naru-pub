import { sql, type Kysely } from "kysely";

// supporter_feature_uses recorded whether an account used the paid features
// after paying, for refund decisions. Refunds no longer ask (any payment inside
// the 7-day window is refundable), so nothing reads it any more.
//
// down recreates the table empty, keyed by the uuid user ids of 1790824144110.
// `any` is required here since migrations should be frozen in time.
export async function up(db: Kysely<any>): Promise<void> {
  await sql`drop table supporter_feature_uses`.execute(db);
}

// `any` is required here since migrations should be frozen in time.
export async function down(db: Kysely<any>): Promise<void> {
  await sql`
    create table supporter_feature_uses (
      user_id uuid not null references users(id) on delete cascade,
      feature text not null,
      first_used_at timestamptz not null default now(),
      last_used_at timestamptz not null default now(),
      constraint supporter_feature_uses_pkey primary key (user_id, feature)
    )
  `.execute(db);
}
