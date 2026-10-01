import { sql, type Kysely } from "kysely";

// Billing keys are stored as they are again (billing_keys.billing_key), not
// encrypted: the key that encrypted them was one more secret to keep and back
// up, for little gain while the Toss secret key sits in the same environment.
// key_hash and key_hint go with the ciphertext: the key itself is unique and
// can be looked up and masked directly.
// `any` is required here since migrations should be frozen in time.
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable("billing_keys")
    .addColumn("billing_key", "text")
    .execute();

  // Production held no encrypted key when this was written, and there is no
  // other environment; one issued since would be lost, so stop instead.
  const held = await sql<{ n: number }>`
    SELECT count(*)::int AS n FROM billing_keys WHERE key_ciphertext IS NOT NULL
  `.execute(db);
  if (held.rows[0].n > 0) {
    throw new Error("billing_keys holds encrypted keys; decrypt them first");
  }

  await sql`
    ALTER TABLE billing_keys DROP CONSTRAINT billing_keys_ciphertext_check
  `.execute(db);
  await db.schema
    .alterTable("billing_keys")
    .dropColumn("key_ciphertext")
    .dropColumn("key_hash")
    .dropColumn("key_hint")
    .execute();
  await sql`
    CREATE UNIQUE INDEX billing_keys_billing_key_idx ON billing_keys (billing_key)
  `.execute(db);
  // Only a key deleted at Toss gives up its value; an active or retired one
  // must keep it, or it could never be charged or deleted.
  await sql`
    ALTER TABLE billing_keys ADD CONSTRAINT billing_keys_value_check
    CHECK ((status = 'deleted') = (billing_key IS NULL))
  `.execute(db);
}

// Payments were never generally available; there is no way back.
// `any` is required here since migrations should be frozen in time.
export async function down(_db: Kysely<any>): Promise<void> {
  throw new Error("irreversible");
}
