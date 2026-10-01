import { createCipheriv, createHash, randomBytes } from "crypto";
import { sql, type Kysely } from "kysely";

// Splits the one reused subscriptions row per user into three things with
// their own lifecycles:
//
// - subscriptions: one row per plan. A signup after a plan ended starts a new
//   row instead of resetting the old one, so a charge of an old plan that
//   lands late finds that plan (ended) and never revives or reshapes the new
//   one. At most one plan per user is live at a time (the partial unique
//   index); created_at is when the plan started, which plan_started_at was.
// - card_registrations: each requestBillingAuth a supporter starts — signup or
//   card change — with the interval chosen and the key it got. A callback acts
//   only on its user's latest registration.
// - billing_keys: every key Toss issued, encrypted (AES-256-GCM with
//   BILLING_KEY_ENCRYPTION_KEY), from active through retired to deleted at
//   Toss, when its ciphertext is dropped. Replaces retired_billing_keys and
//   subscriptions.toss_billing_key; a plan points at its key.
//
// Payments were never generally available, so nothing here is kept backward
// compatible; existing rows are carried over as they are.
// `any` is required here since migrations should be frozen in time.
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable("billing_keys")
    .addColumn("id", "uuid", (col) =>
      col.primaryKey().defaultTo(sql`uuid_v7()`),
    )
    .addColumn("created_at", "timestamptz", (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    // Kept when the account is deleted: its key still has to be deleted at
    // Toss.
    .addColumn("user_id", "uuid", (col) =>
      col.references("users.id").onDelete("set null"),
    )
    .addColumn("customer_key", "text", (col) => col.notNull())
    // sha256 of the key, to find it by the key Toss names (BILLING_DELETED)
    // and to tell a replayed issue from a new one.
    .addColumn("key_hash", "text", (col) => col.notNull().unique())
    .addColumn("key_ciphertext", "text")
    .addColumn("key_hint", "text", (col) => col.notNull())
    .addColumn("card_company", "text")
    .addColumn("card_number", "text")
    .addColumn("status", "text", (col) => col.notNull().defaultTo("active"))
    .addColumn("retired_at", "timestamptz")
    .addColumn("deleted_at", "timestamptz")
    .addColumn("delete_attempts", "integer", (col) =>
      col.notNull().defaultTo(0),
    )
    .addColumn("delete_last_attempted_at", "timestamptz")
    .addColumn("delete_last_error", "text")
    .addCheckConstraint(
      "billing_keys_status_check",
      sql`status in ('active', 'retired', 'deleted')`,
    )
    // Only a key deleted at Toss gives up its ciphertext; an active or
    // retired one must keep it, or it could never be charged or deleted.
    .addCheckConstraint(
      "billing_keys_ciphertext_check",
      sql`(status = 'deleted') = (key_ciphertext is null)`,
    )
    .execute();
  await sql`
    CREATE INDEX billing_keys_retired_idx ON billing_keys (retired_at)
    WHERE status = 'retired'
  `.execute(db);

  await db.schema
    .createTable("card_registrations")
    .addColumn("id", "uuid", (col) =>
      col.primaryKey().defaultTo(sql`uuid_v7()`),
    )
    .addColumn("created_at", "timestamptz", (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .addColumn("user_id", "uuid", (col) =>
      col.notNull().references("users.id").onDelete("cascade"),
    )
    .addColumn("kind", "text", (col) => col.notNull())
    .addColumn("billing_interval", "text")
    // The plan whose card a card change replaces; for a signup, the plan it
    // started, once it did.
    .addColumn("subscription_id", "uuid", (col) =>
      col.references("subscriptions.id").onDelete("set null"),
    )
    .addColumn("billing_key_id", "uuid", (col) =>
      col.references("billing_keys.id").onDelete("set null"),
    )
    .addColumn("completed_at", "timestamptz")
    .addCheckConstraint(
      "card_registrations_kind_check",
      sql`(kind = 'signup' and billing_interval in ('month', 'year'))
        or (kind = 'card_change' and billing_interval is null
          and subscription_id is not null)`,
    )
    .execute();
  await db.schema
    .createIndex("card_registrations_user_id_idx")
    .on("card_registrations")
    .columns(["user_id", "id"])
    .execute();

  await db.schema
    .alterTable("subscriptions")
    .addColumn("billing_key_id", "uuid", (col) =>
      col.references("billing_keys.id").onDelete("set null").unique(),
    )
    .execute();

  // Carry the keys over, encrypted.
  const keyRows = await sql<{
    billing_key: string;
    customer_key: string | null;
    user_id: string | null;
    subscription_id: string | null;
    retired_at: Date | null;
  }>`
    SELECT s.toss_billing_key AS billing_key, s.toss_customer_key::text AS customer_key,
           s.user_id, s.id AS subscription_id, NULL::timestamptz AS retired_at
    FROM subscriptions s WHERE s.toss_billing_key IS NOT NULL
    UNION ALL
    SELECT r.billing_key, NULL, NULL, NULL, r.retired_at
    FROM retired_billing_keys r
    WHERE NOT EXISTS (
      SELECT 1 FROM subscriptions s WHERE s.toss_billing_key = r.billing_key
    )
  `.execute(db);
  const encryptionKey = keyRows.rows.length > 0 ? loadKey() : null;
  for (const row of keyRows.rows) {
    const inserted = await sql<{ id: string }>`
      INSERT INTO billing_keys
        (user_id, customer_key, key_hash, key_ciphertext, key_hint, status, retired_at)
      VALUES (
        ${row.user_id}, ${row.customer_key ?? "unknown"},
        ${createHash("sha256").update(row.billing_key).digest("hex")},
        ${encrypt(encryptionKey!, row.billing_key)},
        ${hint(row.billing_key)},
        ${row.subscription_id ? "active" : "retired"},
        ${row.subscription_id ? null : (row.retired_at ?? new Date())}
      )
      ON CONFLICT (key_hash) DO NOTHING
      RETURNING id
    `.execute(db);
    const id = inserted.rows[0]?.id;
    if (id && row.subscription_id) {
      await sql`UPDATE subscriptions SET billing_key_id = ${id} WHERE id = ${row.subscription_id}`.execute(
        db,
      );
    }
  }

  // The latest registration of each plan, so a callback in flight still
  // matches. A signup whose interval was taken has adopted its key and
  // started its plan; one still waiting has no plan yet — its confirm starts
  // one.
  await sql`
    INSERT INTO card_registrations
      (id, user_id, kind, billing_interval, subscription_id, billing_key_id, completed_at)
    SELECT s.card_registration_id, s.user_id, s.card_registration_kind,
           CASE WHEN s.card_registration_kind = 'signup'
                THEN coalesce(s.card_registration_interval, s.billing_interval) END,
           CASE WHEN s.card_registration_kind = 'card_change'
                  OR s.card_registration_interval IS NULL THEN s.id END,
           CASE WHEN s.card_registration_kind = 'signup'
                 AND s.card_registration_interval IS NULL THEN s.billing_key_id END,
           CASE WHEN s.card_registration_kind = 'signup'
                 AND s.card_registration_interval IS NULL THEN s.updated_at END
    FROM subscriptions s
    WHERE s.card_registration_id IS NOT NULL
      AND s.card_registration_kind IS NOT NULL
  `.execute(db);

  // One plan per row from now on: the user may have several, one live.
  await sql`
    DO $$
    DECLARE c record;
    BEGIN
      FOR c IN
        SELECT con.conname FROM pg_constraint con
        WHERE con.conrelid = 'subscriptions'::regclass AND con.contype = 'u'
          AND con.conkey = ARRAY[(
            SELECT attnum FROM pg_attribute
            WHERE attrelid = 'subscriptions'::regclass AND attname = 'user_id'
          )]
      LOOP
        EXECUTE format('ALTER TABLE subscriptions DROP CONSTRAINT %I', c.conname);
      END LOOP;
    END $$
  `.execute(db);
  await sql`
    CREATE UNIQUE INDEX subscriptions_one_live_plan_idx ON subscriptions (user_id)
    WHERE status IN ('incomplete', 'active', 'scheduled', 'past_due')
  `.execute(db);
  await db.schema
    .createIndex("subscriptions_user_id_idx")
    .on("subscriptions")
    .columns(["user_id", "id"])
    .execute();

  // created_at is now when the plan started.
  await sql`UPDATE subscriptions SET created_at = plan_started_at`.execute(db);
  await db.schema
    .alterTable("subscriptions")
    .dropColumn("toss_billing_key")
    .dropColumn("toss_customer_key")
    .dropColumn("card_registration_id")
    .dropColumn("card_registration_kind")
    .dropColumn("card_registration_interval")
    .dropColumn("plan_started_at")
    .execute();
  await db.schema.dropTable("retired_billing_keys").execute();
}

function loadKey(): Buffer {
  const raw = process.env.BILLING_KEY_ENCRYPTION_KEY;
  const key = raw ? Buffer.from(raw, "base64") : null;
  if (!key || key.length !== 32) {
    throw new Error(
      "BILLING_KEY_ENCRYPTION_KEY must be set to 32 random bytes in base64 to carry billing keys over",
    );
  }
  return key;
}

// The format lib/billing-key-crypto.ts reads, as of this migration.
function encrypt(key: Buffer, plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from("naru billing key"));
  const body = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  return `v1.${Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64")}`;
}

function hint(billingKey: string): string {
  return billingKey.length <= 8
    ? "••••"
    : `${billingKey.slice(0, 4)}••••${billingKey.slice(-4)}`;
}

// Payments were never generally available; there is no way back.
// `any` is required here since migrations should be frozen in time.
export async function down(_db: Kysely<any>): Promise<void> {
  throw new Error("irreversible");
}
