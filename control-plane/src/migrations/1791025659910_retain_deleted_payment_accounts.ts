import { sql, type Kysely } from "kysely";

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable("users")
    .addColumn("deleted_at", "timestamptz")
    .execute();
  // Financial history must never disappear through an unrelated cascade.
  await sql`DO $$ DECLARE fk record; BEGIN
    FOR fk IN SELECT c.conname, c.conrelid::regclass AS tbl,
      pg_get_constraintdef(c.oid) AS definition FROM pg_constraint c
      WHERE c.contype = 'f' AND c.conrelid IN
        ('payments'::regclass, 'subscriptions'::regclass, 'billing_keys'::regclass,
         'card_registrations'::regclass, 'payment_events'::regclass,
         'payment_mails'::regclass, 'payment_transactions'::regclass)
    LOOP
      EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', fk.tbl, fk.conname);
      EXECUTE format('ALTER TABLE %s ADD CONSTRAINT %I %s', fk.tbl, fk.conname,
        regexp_replace(fk.definition, 'ON DELETE (CASCADE|SET NULL)', 'ON DELETE RESTRICT'));
    END LOOP;
  END $$`.execute(db);
  // Reproduce the old account-content cascade, retaining the financial graph.
  await sql`CREATE FUNCTION erase_account_content(account_id uuid) RETURNS void
    LANGUAGE plpgsql AS $$ DECLARE fk record; BEGIN
    FOR fk IN SELECT c.conrelid::regclass AS tbl, a.attname AS col, c.confdeltype
      FROM pg_constraint c JOIN pg_attribute a
        ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
      WHERE c.contype = 'f' AND c.confrelid = 'users'::regclass
        AND c.confdeltype IN ('c', 'n')
    LOOP
      IF fk.confdeltype = 'c' THEN
        EXECUTE format('DELETE FROM %s WHERE %I = $1', fk.tbl, fk.col) USING account_id;
      ELSE
        EXECUTE format('UPDATE %s SET %I = NULL WHERE %I = $1', fk.tbl, fk.col, fk.col) USING account_id;
      END IF;
    END LOOP;
  END $$`.execute(db);
  // A stale profile request cannot restore credentials or access after deletion.
  await sql`CREATE FUNCTION anonymize_deleted_account() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF OLD.deleted_at IS NOT NULL THEN NEW.deleted_at := OLD.deleted_at; END IF;
      IF NEW.deleted_at IS NOT NULL THEN
        NEW.login_name := 'deleted-' || NEW.id::text;
        NEW.password_hash := '';
        NEW.email := NULL;
        NEW.email_verified_at := NULL;
        NEW.discoverable := false;
        NEW.supporter_comp := false;
        NEW.supporter_until := NULL;
        NEW.toss_customer_key := NULL;
        NEW.site_title := NULL;
        NEW.site_rendered_at := NULL;
        NEW.site_updated_at := NULL;
        NEW.last_activity_sent_at := NULL;
        NEW.home_directory_size_bytes := NULL;
        NEW.home_directory_size_bytes_updated_at := NULL;
      END IF;
      RETURN NEW;
    END $$`.execute(db);
  await sql`CREATE TRIGGER anonymize_deleted_account BEFORE UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION anonymize_deleted_account()`.execute(db);
  // Also protects stale requests that passed authentication before deletion.
  await sql`CREATE FUNCTION require_live_payment_account() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      PERFORM 1 FROM users WHERE id = NEW.user_id AND deleted_at IS NULL FOR SHARE;
      IF NOT FOUND THEN RAISE EXCEPTION 'Account is deleted'; END IF;
      RETURN NEW;
    END $$`.execute(db);
  for (const table of [
    "payments",
    "subscriptions",
    "card_registrations",
    "sessions",
  ]) {
    await sql`CREATE TRIGGER require_live_account BEFORE INSERT ON ${sql.table(table)}
      FOR EACH ROW EXECUTE FUNCTION require_live_payment_account()`.execute(db);
  }
}

export async function down(): Promise<void> {
  throw new Error("Account tombstones cannot safely be rolled back");
}
