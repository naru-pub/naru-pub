import { sql, type Kysely } from "kysely";

// Each card registration (requestBillingAuth) that 나루 starts gets an id,
// carried in the callback's path, and only the latest one may store a key.
// The billing key issue call's idempotency key comes from the authKey, and
// Toss replays its first answer for 15 days, so a stale callback reopened
// after a new registration would otherwise get back — and store — the old
// card's key, which has since been retired.
//
// kind says what the registration is for: 'signup' starts recurring billing
// on an incomplete subscription, 'card_change' replaces the key of an active
// or scheduled one. Rows from before this migration have neither, and their
// callbacks (which carry no id) are treated as signups.
// `any` is required here since migrations should be frozen in time.
export async function up(db: Kysely<any>): Promise<void> {
  await sql`
    alter table subscriptions
      add column card_registration_id uuid,
      add column card_registration_kind text
        check (card_registration_kind in ('signup', 'card_change'))
  `.execute(db);
}

// `any` is required here since migrations should be frozen in time.
export async function down(db: Kysely<any>): Promise<void> {
  await sql`
    alter table subscriptions
      drop column card_registration_id,
      drop column card_registration_kind
  `.execute(db);
}
