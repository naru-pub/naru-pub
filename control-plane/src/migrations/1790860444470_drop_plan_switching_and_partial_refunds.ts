import { sql, type Kysely } from "kysely";

// Three features go:
// - a one-time purchase no longer switches off a running plan (it is not
//   offered beside one), so subscriptions.status loses switched_to_one_time;
// - 나루 sells no partial refunds, so a partial cancel from the Toss dashboard
//   is recorded as canceled, and payments.status loses partial_canceled;
// - an operator refund always ends the plan, so payments.refund_keeps_plan
//   goes.
// Existing rows move to canceled, with the trigger that keeps transitions in
// line replaced first.
// `any` is required here since migrations should be frozen in time.
export async function up(db: Kysely<any>): Promise<void> {
  await sql`
    CREATE OR REPLACE FUNCTION subscription_status_transition() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
        (OLD.status = 'incomplete' AND NEW.status IN
          ('active', 'scheduled', 'canceled')) OR
        (OLD.status = 'scheduled' AND NEW.status IN
          ('active', 'past_due', 'canceled')) OR
        (OLD.status = 'active' AND NEW.status IN ('past_due', 'canceled')) OR
        (OLD.status = 'past_due' AND NEW.status IN ('active', 'canceled')) OR
        -- Only for this migration's own rewrite of a status that is gone.
        (OLD.status = 'switched_to_one_time' AND NEW.status = 'canceled')
      ) THEN
        RAISE EXCEPTION 'subscription % may not go from % to %',
          OLD.id, OLD.status, NEW.status
          USING ERRCODE = 'check_violation';
      END IF;
      RETURN NEW;
    END;
    $$
  `.execute(db);
  await sql`
    CREATE OR REPLACE FUNCTION payment_status_transition() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
        (OLD.status = 'pending' AND NEW.status IN
          ('done', 'failed', 'aborted', 'expired', 'canceled')) OR
        (OLD.status = 'done' AND NEW.status = 'canceled') OR
        (OLD.status IN ('failed', 'aborted', 'expired')
          AND NEW.status = 'pending') OR
        -- Only for this migration's own rewrite of a status that is gone.
        (OLD.status = 'partial_canceled' AND NEW.status = 'canceled')
      ) THEN
        RAISE EXCEPTION 'payment % may not go from % to %',
          OLD.id, OLD.status, NEW.status
          USING ERRCODE = 'check_violation';
      END IF;
      RETURN NEW;
    END;
    $$
  `.execute(db);

  await sql`
    UPDATE subscriptions SET status = 'canceled'
    WHERE status = 'switched_to_one_time'
  `.execute(db);
  await sql`
    UPDATE payments SET status = 'canceled' WHERE status = 'partial_canceled'
  `.execute(db);

  await sql`
    ALTER TABLE subscriptions DROP CONSTRAINT subscriptions_status_check,
    ADD CONSTRAINT subscriptions_status_check CHECK (status IN
      ('incomplete', 'active', 'scheduled', 'past_due', 'canceled'))
  `.execute(db);
  await sql`
    ALTER TABLE payments DROP CONSTRAINT payments_status_check,
    ADD CONSTRAINT payments_status_check CHECK (status IN
      ('pending', 'done', 'failed', 'aborted', 'expired', 'canceled'))
  `.execute(db);
  await sql`
    ALTER TABLE payments DROP CONSTRAINT payments_refund_check,
    ADD CONSTRAINT payments_refund_check CHECK (refunded_amount >= 0
      AND refunded_amount <= amount
      AND (refunded_amount = 0 OR status = 'canceled'))
  `.execute(db);
  // The statuses that left are gone from the constraints; the trigger keeps
  // only the transitions that remain (the rewrite clauses above can no
  // longer match).
  await db.schema
    .alterTable("payments")
    .dropColumn("refund_keeps_plan")
    .execute();
  await sql`
    CREATE OR REPLACE FUNCTION subscription_key_matches_status() RETURNS trigger
    LANGUAGE plpgsql AS $$
    DECLARE s record;
    BEGIN
      SELECT status, billing_key_id, next_billing_at INTO s
      FROM subscriptions WHERE id = NEW.id;
      IF NOT FOUND THEN
        RETURN NULL;
      END IF;
      IF s.status = 'canceled'
         AND (s.billing_key_id IS NOT NULL OR s.next_billing_at IS NOT NULL) THEN
        RAISE EXCEPTION 'ended subscription % still holds a key or a next charge', NEW.id
          USING ERRCODE = 'check_violation';
      END IF;
      IF s.status IN ('active', 'scheduled')
         AND (s.billing_key_id IS NULL OR s.next_billing_at IS NULL) THEN
        RAISE EXCEPTION 'running subscription % has no key or no next charge', NEW.id
          USING ERRCODE = 'check_violation';
      END IF;
      RETURN NULL;
    END;
    $$
  `.execute(db);
}

// Payments were never generally available; there is no way back.
// `any` is required here since migrations should be frozen in time.
export async function down(_db: Kysely<any>): Promise<void> {
  throw new Error("irreversible");
}
