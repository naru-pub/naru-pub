import { Pool } from "pg";
import { Kysely, PostgresDialect, sql } from "kysely";
import { DB } from "./db";

// The whole control plane — sign-in, the file browser, billing, the public
// site-data API — shares this one pool, so a burst on any single endpoint is a
// burst on all of them. The public data API is the one path a stranger can
// drive at will, which makes these bounds load-bearing rather than tuning.
const poolSize = Number(process.env.DATABASE_POOL_MAX);
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: Number.isInteger(poolSize) && poolSize > 0 ? poolSize : 20,
  // Without this a checkout waits forever, so a saturated pool becomes a hang
  // rather than an error. Shedding the request keeps the process answering.
  connectionTimeoutMillis: 10000,
});

// Statement deadlines are set per transaction rather than on the pool: the same
// pool backs migrations and the cron backfills, where a multi-minute statement
// is correct. Only request paths a stranger can drive get a deadline.
export const REQUEST_STATEMENT_TIMEOUT_MS = 15000;

export const db = new Kysely<DB>({
  dialect: new PostgresDialect({
    pool,
  }),
});

/**
 * Bounds every statement in one transaction. `SET LOCAL` reverts on commit or
 * rollback, so the connection returns to the pool with the pool's own defaults
 * intact and the migrations sharing it are unaffected.
 *
 * Applied to request paths a stranger can drive: without it one pathological
 * query holds a connection, and on the data API an owner row lock, for as long
 * as PostgreSQL is willing to run it.
 */
export async function requestDeadline(
  executor: Kysely<DB>,
  milliseconds: number = REQUEST_STATEMENT_TIMEOUT_MS,
) {
  // SET LOCAL takes no bind parameters, so the value is inlined. It is an
  // integer this module owns, never anything a caller supplies.
  await sql
    .raw(`set local statement_timeout = ${Math.trunc(milliseconds)}`)
    .execute(executor);
}

/**
 * Records a site edit by updating site_updated_at and incrementing daily edit stats.
 * Use this instead of directly updating site_updated_at.
 */
export async function recordSiteEdit(userId: string): Promise<void> {
  // Update site_updated_at
  await db
    .updateTable("users")
    .set("site_updated_at", new Date())
    .where("id", "=", userId)
    .execute();

  // Upsert daily edit stats
  await sql`
    INSERT INTO edit_daily_stats (user_id, date, edit_count)
    VALUES (${userId}, CURRENT_DATE, 1)
    ON CONFLICT (user_id, date) DO UPDATE SET
      edit_count = edit_daily_stats.edit_count + 1
  `.execute(db);
}
