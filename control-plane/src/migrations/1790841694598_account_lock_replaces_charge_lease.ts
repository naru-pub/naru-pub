import type { Kysely } from "kysely";

// Payment operations on one account are now serialized by a PostgreSQL
// advisory lock (lib/payments/account-lock.ts, docs/design/payment-account-lock.md), so
// the charge lease on subscriptions goes.
//
// charge_attempted_at is when a charge or confirm for the order was last sent
// to Toss. An order Toss has not heard of is expired 45 minutes after that,
// not after the order was made: a reused order's charge that timed out may
// still be approved, and its creation can be a day old.
//
// card_registration_interval is the plan a pending signup registration chose.
// Prepare records only the registration; the subscription's status, plan and
// key change at confirm, once the new card is actually registered.
// `any` is required here since migrations should be frozen in time.
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable("subscriptions")
    .dropColumn("charging_started_at")
    .execute();
  await db.schema
    .alterTable("payments")
    .addColumn("charge_attempted_at", "timestamptz")
    .execute();
  await db.schema
    .alterTable("subscriptions")
    .addColumn("card_registration_interval", "text")
    .execute();
}

// `any` is required here since migrations should be frozen in time.
export async function down(db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable("subscriptions")
    .dropColumn("card_registration_interval")
    .execute();
  await db.schema
    .alterTable("payments")
    .dropColumn("charge_attempted_at")
    .execute();
  await db.schema
    .alterTable("subscriptions")
    .addColumn("charging_started_at", "timestamptz")
    .execute();
}
