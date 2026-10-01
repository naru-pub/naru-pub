import { sql, type Kysely } from "kysely";

// The payment data's rules, kept by the database instead of only checked
// overnight (lib/payments/payment-invariants.ts), so a write that breaks one fails:
//
// - statuses are one of a known set, and change only along the transitions
//   in lib/payments/payment-states.ts (a trigger; a test compares the two);
// - an ended plan holds no billing key and no next charge, a running one
//   (active, scheduled) holds both — checked when the transaction commits,
//   since a cancel ends the plan and retires its key in two statements;
// - a done payment has its payment time and period, and only a canceled one
//   has a refunded amount, never more than it was.
// `any` is required here since migrations should be frozen in time.
export async function up(db: Kysely<any>): Promise<void> {
  await sql`
    ALTER TABLE subscriptions ADD CONSTRAINT subscriptions_status_check
    CHECK (status IN ('incomplete', 'active', 'scheduled', 'past_due',
                      'canceled', 'switched_to_one_time'))
  `.execute(db);
  await sql`
    ALTER TABLE payments ADD CONSTRAINT payments_status_check
    CHECK (status IN ('pending', 'done', 'failed', 'aborted', 'expired',
                      'canceled', 'partial_canceled'))
  `.execute(db);
  await sql`
    ALTER TABLE payments ADD CONSTRAINT payments_done_has_period_check
    CHECK (status <> 'done' OR (paid_at IS NOT NULL
      AND period_start IS NOT NULL AND period_end IS NOT NULL))
  `.execute(db);
  await sql`
    ALTER TABLE payments ADD CONSTRAINT payments_refund_check
    CHECK (refunded_amount >= 0 AND refunded_amount <= amount
      AND (refunded_amount = 0 OR status IN ('canceled', 'partial_canceled')))
  `.execute(db);

  await sql`
    CREATE FUNCTION subscription_status_transition() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
        (OLD.status = 'incomplete' AND NEW.status IN
          ('active', 'scheduled', 'canceled', 'switched_to_one_time')) OR
        (OLD.status = 'scheduled' AND NEW.status IN
          ('active', 'past_due', 'canceled', 'switched_to_one_time')) OR
        (OLD.status = 'active' AND NEW.status IN
          ('past_due', 'canceled', 'switched_to_one_time')) OR
        (OLD.status = 'past_due' AND NEW.status IN
          ('active', 'canceled', 'switched_to_one_time')) OR
        (OLD.status = 'canceled' AND NEW.status IN ('switched_to_one_time'))
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
    CREATE TRIGGER subscriptions_status_transition
    BEFORE UPDATE OF status ON subscriptions
    FOR EACH ROW EXECUTE FUNCTION subscription_status_transition()
  `.execute(db);

  await sql`
    CREATE FUNCTION payment_status_transition() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
        (OLD.status = 'pending' AND NEW.status IN
          ('done', 'failed', 'aborted', 'expired', 'canceled',
           'partial_canceled')) OR
        (OLD.status = 'done' AND NEW.status IN
          ('canceled', 'partial_canceled')) OR
        (OLD.status IN ('failed', 'aborted', 'expired')
          AND NEW.status = 'pending') OR
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
    CREATE TRIGGER payments_status_transition
    BEFORE UPDATE OF status ON payments
    FOR EACH ROW EXECUTE FUNCTION payment_status_transition()
  `.execute(db);

  // A plan's key and its status agree once the transaction is done.
  await sql`
    CREATE FUNCTION subscription_key_matches_status() RETURNS trigger
    LANGUAGE plpgsql AS $$
    DECLARE s record;
    BEGIN
      SELECT status, billing_key_id, next_billing_at INTO s
      FROM subscriptions WHERE id = NEW.id;
      IF NOT FOUND THEN
        RETURN NULL;
      END IF;
      IF s.status IN ('canceled', 'switched_to_one_time')
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
  await sql`
    CREATE CONSTRAINT TRIGGER subscriptions_key_matches_status
    AFTER INSERT OR UPDATE ON subscriptions
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION subscription_key_matches_status()
  `.execute(db);

  // A billing key a plan points at is one that may be charged.
  await sql`
    CREATE FUNCTION subscription_key_is_active() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM subscriptions s JOIN billing_keys k ON k.id = s.billing_key_id
        WHERE k.id = NEW.id AND k.status <> 'active'
      ) THEN
        RAISE EXCEPTION 'billing key % is % but a subscription holds it', NEW.id, NEW.status
          USING ERRCODE = 'check_violation';
      END IF;
      RETURN NULL;
    END;
    $$
  `.execute(db);
  await sql`
    CREATE CONSTRAINT TRIGGER billing_keys_held_are_active
    AFTER UPDATE OF status ON billing_keys
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION subscription_key_is_active()
  `.execute(db);
}

// `any` is required here since migrations should be frozen in time.
export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP TRIGGER billing_keys_held_are_active ON billing_keys`.execute(
    db,
  );
  await sql`DROP FUNCTION subscription_key_is_active()`.execute(db);
  await sql`DROP TRIGGER subscriptions_key_matches_status ON subscriptions`.execute(
    db,
  );
  await sql`DROP FUNCTION subscription_key_matches_status()`.execute(db);
  await sql`DROP TRIGGER payments_status_transition ON payments`.execute(db);
  await sql`DROP FUNCTION payment_status_transition()`.execute(db);
  await sql`DROP TRIGGER subscriptions_status_transition ON subscriptions`.execute(
    db,
  );
  await sql`DROP FUNCTION subscription_status_transition()`.execute(db);
  await sql`ALTER TABLE payments DROP CONSTRAINT payments_refund_check`.execute(
    db,
  );
  await sql`ALTER TABLE payments DROP CONSTRAINT payments_done_has_period_check`.execute(
    db,
  );
  await sql`ALTER TABLE payments DROP CONSTRAINT payments_status_check`.execute(
    db,
  );
  await sql`ALTER TABLE subscriptions DROP CONSTRAINT subscriptions_status_check`.execute(
    db,
  );
}
