import { sql, type Kysely } from "kysely";

// `any` is required here since migrations should be frozen in time.
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable("payments")
    .addColumn("paid_time_revoked_at", "timestamptz")
    .execute();
  await sql`
    CREATE FUNCTION compact_refunded_paid_periods(account_id uuid) RETURNS void
    LANGUAGE plpgsql AS $$
    DECLARE refund_id uuid; refunded record; queued record;
      removed interval; frontier timestamptz;
    BEGIN
      PERFORM id FROM users WHERE id = account_id FOR NO KEY UPDATE;
      FOR refund_id IN SELECT id FROM payments
        WHERE user_id = account_id AND refunded_amount > 0 AND paid_time_revoked_at IS NULL
        ORDER BY refunded_at NULLS LAST, id
      LOOP
        -- Earlier refunds in this loop can move this refund's own allocation.
        SELECT * INTO refunded FROM payments WHERE id = refund_id;
        IF refunded.period_start IS NOT NULL AND refunded.period_end > refunded.period_start
          AND NOT EXISTS (SELECT 1 FROM payments WHERE user_id = account_id
            AND refunded_amount = 0 AND period_start < refunded.period_end
            AND period_end > refunded.period_start) THEN
          -- A replacement overlapping this allocation means an older refund
          -- already shortened access before the replacement was purchased.
          removed := refunded.period_end - refunded.period_start;
          frontier := refunded.period_end;
          FOR queued IN SELECT id, period_start, period_end FROM payments
            WHERE user_id = account_id AND id <> refund_id
              AND period_start >= refunded.period_end AND period_end IS NOT NULL
            ORDER BY period_start, period_end, id
          LOOP
            -- An independent purchase after a gap is not queued behind this one.
            EXIT WHEN queued.period_start > frontier;
            frontier := greatest(frontier, queued.period_end);
            UPDATE payments SET period_start = queued.period_start - removed,
              period_end = queued.period_end - removed WHERE id = queued.id;
          END LOOP;
        END IF;
        UPDATE payments SET paid_time_revoked_at = now() WHERE id = refund_id;
      END LOOP;
    END $$;
  `.execute(db);
  // Repair historical refunds too. Serialize with the application's account
  // lock, retain all money records, and never extend an account's entitlement.
  await sql`
    DO $$ DECLARE account_id uuid; until_at timestamptz; BEGIN
      FOR account_id IN SELECT DISTINCT user_id FROM payments WHERE refunded_amount > 0 LOOP
        PERFORM pg_advisory_xact_lock(1346459953, hashtext(account_id::text));
        PERFORM compact_refunded_paid_periods(account_id);
        SELECT max(period_end) INTO until_at FROM payments
          WHERE user_id = account_id AND refunded_amount = 0;
        UPDATE users SET supporter_until = until_at WHERE id = account_id
          AND supporter_until IS NOT NULL AND (until_at IS NULL OR until_at < supporter_until);
        UPDATE subscriptions SET current_period_end = greatest(until_at, now()),
          next_billing_at = greatest(until_at, now()), updated_at = now()
          WHERE user_id = account_id AND status IN ('active', 'scheduled')
            AND next_billing_at > greatest(until_at, now());
      END LOOP;
    END $$;
  `.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DO $$ BEGIN RAISE EXCEPTION 'Refunded allocations cannot be restored; deploy a forward fix'; END $$`.execute(
    db,
  );
}
