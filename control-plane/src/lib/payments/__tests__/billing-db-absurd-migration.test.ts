/** @jest-environment node */
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "@jest/globals";
import { randomUUID } from "crypto";
import { Kysely, PostgresDialect, sql } from "kysely";
import { Client, Pool } from "pg";
import { up as createLegacyJobs } from "@/migrations/1790844485125_add_payment_jobs";
import { up as adoptAbsurd } from "@/migrations/1791014528237_adopt_absurd_payment_workflows";

const integration =
  process.env.NARU_PAYMENTS_DB_TEST === "1" ? describe : describe.skip;

integration("Absurd payment migration", () => {
  const name = `absurd_migration_${randomUUID().replaceAll("-", "")}`;
  let admin: Client;
  let db: Kysely<Record<string, never>>;

  beforeAll(async () => {
    admin = new Client({ connectionString: process.env.DATABASE_URL });
    await admin.connect();
    await admin.query(`create database ${name}`);
    const url = new URL(process.env.DATABASE_URL!);
    url.pathname = `/${name}`;
    db = new Kysely({
      dialect: new PostgresDialect({
        pool: new Pool({ connectionString: url.toString() }),
      }),
    });
    // Minimal pre-cutover fixture; the old queue is created by its real migration.
    await sql`create function uuid_v7() returns uuid language sql as 'select gen_random_uuid()';
      create table subscriptions (id uuid primary key);
      create table payments (id uuid primary key);
      create table payment_events (id uuid primary key default uuid_v7(), kind text, summary text)`.execute(
      db,
    );
  });

  beforeEach(async () => {
    await sql`drop schema if exists absurd cascade;
      drop table if exists payment_jobs;
      drop function if exists report_failed_payment_task();
      alter table payments drop column if exists refund_requested_at,
        drop column if exists refund_subscription_id;
      truncate payment_events`.execute(db);
    await createLegacyJobs(db);
  });

  afterAll(async () => {
    await db?.destroy();
    if (admin) {
      await admin.query(`drop database if exists ${name}`);
      await admin.end();
    }
  });

  test("imports pending work, schedules, terminal history, and dedupe identities", async () => {
    const due = new Date(Date.now() + 86_400_000);
    await sql`insert into payment_jobs (kind, payload, dedupe_key, run_at, attempts, done_at, failed_at, last_error)
      values
      ('thank_you', '{"kind":"thank_you","paymentId":"pending"}', 'pending', ${due}, 3, null, null, 'temporary'),
      ('thank_you', '{"kind":"thank_you","paymentId":"done"}', 'done', now(), 1, now(), null, null),
      ('thank_you', '{"kind":"thank_you","paymentId":"failed"}', 'failed', now(), 8, null, now(), 'permanent')`.execute(
      db,
    );
    await db.transaction().execute(adoptAbsurd);
    const { rows } = await sql<{
      idempotency_key: string;
      state: string;
      max_attempts: number;
      available_at: Date;
    }>`
      select t.idempotency_key, t.state, t.max_attempts, r.available_at
      from absurd.t_payments t join absurd.r_payments r on r.task_id = t.task_id
      order by idempotency_key`.execute(db);
    expect(
      rows.map(({ idempotency_key, state }) => ({ idempotency_key, state })),
    ).toEqual([
      { idempotency_key: "done", state: "completed" },
      { idempotency_key: "failed", state: "failed" },
      { idempotency_key: "pending", state: "pending" },
    ]);
    expect(rows[2].max_attempts).toBe(5);
    expect(new Date(rows[2].available_at).getTime()).toBe(due.getTime());
    const deduped = await sql<{
      created: boolean;
    }>`select created from absurd.spawn_task('payments', 'payment-job-v1', '{}', '{"idempotency_key":"done"}')`.execute(
      db,
    );
    expect(deduped.rows[0].created).toBe(false);
    const legacy = await sql<{
      table: string | null;
    }>`select to_regclass('public.payment_jobs')::text as "table"`.execute(db);
    expect(legacy.rows[0].table).toBeNull();
  });

  test("imports claims left behind by stopped workers without waiting for lease expiry", async () => {
    await sql`insert into payment_jobs (kind, payload, locked_until)
      values ('thank_you', '{"kind":"thank_you","paymentId":"claimed"}', now() + interval '5 minutes')`.execute(
      db,
    );
    await db.transaction().execute(adoptAbsurd);
    const tasks = await sql<{
      state: string;
    }>`select state from absurd.t_payments`.execute(db);
    expect(tasks.rows).toEqual([{ state: "pending" }]);
  });
});
