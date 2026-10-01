import { type Kysely } from "kysely";

// The Toss merchant (MID) that issued each billing key, from the issue
// response's mId. A key is chargeable only through the MID that issued it, so
// renewals skip a key of another MID — a test-mode key once the live keys are
// in — instead of failing it as a decline (lib/payments/subscription-renewals).
// Keys issued before this have none; production held no keys when it ran.
// `any` is required here since migrations should be frozen in time.
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable("billing_keys")
    .addColumn("toss_mid", "text")
    .execute();
}

// `any` is required here since migrations should be frozen in time.
export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable("billing_keys").dropColumn("toss_mid").execute();
}
