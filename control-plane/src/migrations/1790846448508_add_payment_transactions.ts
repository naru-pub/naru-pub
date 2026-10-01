import { sql, type Kysely } from "kysely";

// The money that moved, one row per movement, never changed afterwards: an
// approval when Toss approved a payment, and each cancel Toss made of it —
// full, partial, from 나루 or from the Toss dashboard — keyed by Toss's
// transactionKey, so seeing the same cancel twice records it once.
// payments.refunded_amount is the sum of a payment's cancels here
// (lib/payments/payment-ledger.ts); the invariant check compares them.
//
// Rows are only inserted: a trigger refuses UPDATE. DELETE stays possible
// for the cascade from a deleted account, whose payments go with it.
// `any` is required here since migrations should be frozen in time.
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable("payment_transactions")
    .addColumn("id", "uuid", (col) =>
      col.primaryKey().defaultTo(sql`uuid_v7()`),
    )
    .addColumn("created_at", "timestamptz", (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .addColumn("payment_id", "uuid", (col) =>
      col.notNull().references("payments.id").onDelete("cascade"),
    )
    .addColumn("kind", "text", (col) => col.notNull())
    .addColumn("amount", "integer", (col) => col.notNull())
    .addColumn("transaction_key", "text", (col) => col.notNull().unique())
    .addColumn("occurred_at", "timestamptz", (col) => col.notNull())
    .addCheckConstraint(
      "payment_transactions_kind_check",
      sql`kind in ('approval', 'cancel')`,
    )
    .addCheckConstraint("payment_transactions_amount_check", sql`amount > 0`)
    .execute();
  await db.schema
    .createIndex("payment_transactions_payment_id_idx")
    .on("payment_transactions")
    .column("payment_id")
    .execute();
  // One approval per payment.
  await sql`
    CREATE UNIQUE INDEX payment_transactions_one_approval_idx
    ON payment_transactions (payment_id) WHERE kind = 'approval'
  `.execute(db);

  await sql`
    CREATE FUNCTION payment_transactions_append_only() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
      RAISE EXCEPTION 'payment_transactions is append-only';
    END;
    $$
  `.execute(db);
  await sql`
    CREATE TRIGGER payment_transactions_no_update
    BEFORE UPDATE ON payment_transactions
    FOR EACH ROW EXECUTE FUNCTION payment_transactions_append_only()
  `.execute(db);

  // What the payments say so far: their approvals, the cancels in the last
  // answer Toss gave for each (payments.raw), keyed as lib/payments/payment-ledger.ts
  // keys them, and — where that answer has none — what was refunded as one
  // cancel.
  await sql`
    INSERT INTO payment_transactions (payment_id, kind, amount, transaction_key, occurred_at)
    SELECT id, 'approval', amount, 'approval:' || id, paid_at
    FROM payments
    WHERE paid_at IS NOT NULL AND amount > 0
      AND status IN ('done', 'canceled', 'partial_canceled')
  `.execute(db);
  await sql`
    INSERT INTO payment_transactions (payment_id, kind, amount, transaction_key, occurred_at)
    SELECT p.id, 'cancel', (c->>'cancelAmount')::int,
           coalesce(c->>'transactionKey',
                    'cancel:' || p.toss_payment_key || ':' || (t.ord - 1)),
           coalesce((c->>'canceledAt')::timestamptz, p.refunded_at, p.created_at)
    FROM payments p,
         jsonb_array_elements(
           CASE WHEN jsonb_typeof(p.raw->'cancels') = 'array'
                THEN p.raw->'cancels' END
         ) WITH ORDINALITY AS t(c, ord)
    WHERE p.refunded_amount > 0
      AND (c->>'cancelAmount')::int > 0
    ON CONFLICT (transaction_key) DO NOTHING
  `.execute(db);
  await sql`
    INSERT INTO payment_transactions (payment_id, kind, amount, transaction_key, occurred_at)
    SELECT p.id, 'cancel', p.refunded_amount, 'backfill-cancel:' || p.id,
           coalesce(p.refunded_at, p.paid_at, p.created_at)
    FROM payments p
    WHERE p.refunded_amount > 0
      AND NOT EXISTS (
        SELECT 1 FROM payment_transactions t
        WHERE t.payment_id = p.id AND t.kind = 'cancel'
      )
  `.execute(db);
}

// `any` is required here since migrations should be frozen in time.
export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable("payment_transactions").execute();
  await sql`DROP FUNCTION payment_transactions_append_only()`.execute(db);
}
