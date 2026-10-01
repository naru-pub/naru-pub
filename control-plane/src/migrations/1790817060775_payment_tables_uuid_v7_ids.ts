import { sql, type Kysely } from "kysely";

// The payment tables are keyed by UUIDv7 instead of sequence numbers, so their
// ids (in /api/account/payments/<id>/…, in the operator pages) don't reveal how
// many payments there have been or let anyone walk them in order.
//
// v7 rather than gen_random_uuid(): v7 ids sort by creation time, and the
// billing code relies on id order — the latest attempt for a renewal, the
// oldest event for a digest. PostgreSQL only has uuidv7() from 18, and CI runs
// older versions, so uuid_v7() is defined here. Existing rows get ids made
// from their own creation time, so their order survives.
//
// Attempt keys name their subscription (subscription:<id>:…,
// subscription_initial:<id>:…) and are how a pending order is found again
// instead of being charged anew, so they are rewritten to the new ids in the
// same transaction.
//
// Tables: subscriptions, payments, payment_events, toss_webhook_deliveries,
// retired_billing_keys. user_id columns stay integers (users keep theirs).

const TABLES = [
  { table: "subscriptions", createdAt: "created_at" },
  { table: "payments", createdAt: "created_at" },
  { table: "payment_events", createdAt: "created_at" },
  { table: "toss_webhook_deliveries", createdAt: "received_at" },
  { table: "retired_billing_keys", createdAt: "retired_at" },
] as const;

const SERIAL = "[0-9]+";
const UUID = "[0-9a-f-]{36}";

// Rewrites the subscription id inside an attempt key, keeping its prefix and
// everything after the id. `oldId` is the pattern of the id being replaced.
function rewriteAttemptKey(newId: string, oldId: string) {
  return sql`
    (case when p.attempt_key like 'subscription_initial:%'
      then 'subscription_initial:' else 'subscription:' end)
    || ${sql.raw(newId)}::text
    || substring(p.attempt_key from ${`^subscription(?:_initial)?:${oldId}(:.*)$`})
  `;
}

export async function up(db: Kysely<any>): Promise<void> {
  // RFC 9562 UUIDv7: 48 bits of Unix time in milliseconds, the version, then
  // 12 bits of sub-millisecond time where plain v7 has random bits ("method
  // 3", as PostgreSQL 18's own uuidv7() does), then 62 random bits with the
  // variant. The sub-millisecond bits keep ids made one after another — two
  // events in one transaction — in the order they were made.
  await sql`
    create function uuid_v7(ts timestamptz default clock_timestamp())
    returns uuid language sql volatile as $$
      with t as (select extract(epoch from ts) * 1000 as ms)
      select encode(
        substring(int8send(floor(ms)::bigint) from 3)
        || int2send((28672 + floor((ms - floor(ms)) * 4096))::smallint)
        || substring(uuid_send(gen_random_uuid()) from 9),
        'hex')::uuid
      from t
    $$
  `.execute(db);

  for (const { table, createdAt } of TABLES) {
    await sql`alter table ${sql.table(table)} add column new_id uuid`.execute(
      db,
    );
    // Rows written in one transaction share a timestamp; the old sequence
    // number orders them, a microsecond apart.
    await sql`
      with ranked as (
        select id, ${sql.ref(createdAt)} + (row_number() over (
          partition by ${sql.ref(createdAt)} order by id
        ) - 1) * interval '1 microsecond' as ts
        from ${sql.table(table)}
      )
      update ${sql.table(table)} t set new_id = uuid_v7(ranked.ts)
      from ranked where ranked.id = t.id
    `.execute(db);
  }

  await sql`alter table payments add column new_subscription_id uuid`.execute(
    db,
  );
  await sql`
    update payments p set new_subscription_id = s.new_id
    from subscriptions s where s.id = p.subscription_id
  `.execute(db);
  await sql`
    update payments p set attempt_key = ${rewriteAttemptKey("s.new_id", SERIAL)}
    from subscriptions s
    where substring(p.attempt_key from ${`^subscription(?:_initial)?:(${SERIAL}):`})::int = s.id
  `.execute(db);

  await sql`
    alter table payment_events
      add column new_payment_id uuid,
      add column new_subscription_id uuid
  `.execute(db);
  await sql`
    update payment_events e set new_payment_id = p.new_id
    from payments p where p.id = e.payment_id
  `.execute(db);
  await sql`
    update payment_events e set new_subscription_id = s.new_id
    from subscriptions s where s.id = e.subscription_id
  `.execute(db);

  // Referencing columns first, then the keys they referenced. Indexes and
  // foreign keys on a dropped column go with it.
  await sql`alter table payment_events drop column payment_id, drop column subscription_id`.execute(
    db,
  );
  await sql`alter table payments drop column subscription_id`.execute(db);
  for (const { table } of TABLES) {
    await sql`alter table ${sql.table(table)} drop column id`.execute(db);
    await sql`alter table ${sql.table(table)} rename column new_id to id`.execute(
      db,
    );
    await sql`
      alter table ${sql.table(table)}
        alter column id set not null,
        alter column id set default uuid_v7(),
        add primary key (id)
    `.execute(db);
  }

  await sql`alter table payments rename column new_subscription_id to subscription_id`.execute(
    db,
  );
  await sql`
    alter table payments add constraint payments_subscription_id_fkey
      foreign key (subscription_id) references subscriptions (id) on delete set null
  `.execute(db);
  await sql`
    alter table payment_events
      rename column new_payment_id to payment_id
  `.execute(db);
  await sql`
    alter table payment_events
      rename column new_subscription_id to subscription_id
  `.execute(db);
  await sql`
    alter table payment_events
      add constraint payment_events_payment_id_fkey
        foreign key (payment_id) references payments (id) on delete set null,
      add constraint payment_events_subscription_id_fkey
        foreign key (subscription_id) references subscriptions (id) on delete set null
  `.execute(db);
  await sql`create index payment_events_unsent_idx on payment_events (id) where emailed_at is null`.execute(
    db,
  );
}

// Sequence numbers again, assigned in id (that is, creation) order, with
// attempt keys and references following.
export async function down(db: Kysely<any>): Promise<void> {
  for (const { table } of TABLES) {
    await sql`alter table ${sql.table(table)} add column serial bigserial`.execute(
      db,
    );
    await sql`
      with ordered as (
        select id, row_number() over (order by id) as n from ${sql.table(table)}
      )
      update ${sql.table(table)} t set serial = ordered.n
      from ordered where ordered.id = t.id
    `.execute(db);
    await sql`select setval(pg_get_serial_sequence(${table}, 'serial'), coalesce((select max(serial) from ${sql.table(table)}), 0) + 1, false)`.execute(
      db,
    );
  }

  await sql`alter table payments add column serial_subscription_id integer`.execute(
    db,
  );
  await sql`
    update payments p set serial_subscription_id = s.serial
    from subscriptions s where s.id = p.subscription_id
  `.execute(db);
  await sql`
    update payments p set attempt_key = ${rewriteAttemptKey("s.serial", UUID)}
    from subscriptions s
    where substring(p.attempt_key from ${`^subscription(?:_initial)?:(${UUID}):`})::uuid = s.id
  `.execute(db);

  await sql`
    alter table payment_events
      add column serial_payment_id integer,
      add column serial_subscription_id integer
  `.execute(db);
  await sql`
    update payment_events e set serial_payment_id = p.serial
    from payments p where p.id = e.payment_id
  `.execute(db);
  await sql`
    update payment_events e set serial_subscription_id = s.serial
    from subscriptions s where s.id = e.subscription_id
  `.execute(db);

  await sql`alter table payment_events drop column payment_id, drop column subscription_id`.execute(
    db,
  );
  await sql`alter table payments drop column subscription_id`.execute(db);
  for (const { table } of TABLES) {
    await sql`alter table ${sql.table(table)} drop column id`.execute(db);
    await sql`alter table ${sql.table(table)} rename column serial to id`.execute(
      db,
    );
    await sql`alter sequence ${sql.raw(`${table}_serial_seq`)} rename to ${sql.raw(`${table}_id_seq`)}`.execute(
      db,
    );
    await sql`alter table ${sql.table(table)} alter column id type integer, add primary key (id)`.execute(
      db,
    );
  }

  await sql`alter table payments rename column serial_subscription_id to subscription_id`.execute(
    db,
  );
  await sql`
    alter table payments add constraint payments_subscription_id_fkey
      foreign key (subscription_id) references subscriptions (id) on delete set null
  `.execute(db);
  await sql`alter table payment_events rename column serial_payment_id to payment_id`.execute(
    db,
  );
  await sql`alter table payment_events rename column serial_subscription_id to subscription_id`.execute(
    db,
  );
  await sql`
    alter table payment_events
      add constraint payment_events_payment_id_fkey
        foreign key (payment_id) references payments (id) on delete set null,
      add constraint payment_events_subscription_id_fkey
        foreign key (subscription_id) references subscriptions (id) on delete set null
  `.execute(db);
  await sql`create index payment_events_unsent_idx on payment_events (id) where emailed_at is null`.execute(
    db,
  );
  await sql`drop function uuid_v7(timestamptz)`.execute(db);
}
