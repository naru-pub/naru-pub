import { AsyncLocalStorage } from "async_hooks";
import { Pool, type PoolClient } from "pg";

// One operation that can move money or change an account's billing state runs
// at a time per account: signup and card change, one-time purchases, renewals,
// reconciliation, refunds, cancellation, webhooks, account deletion, recovery.
// See docs/design/payment-account-lock.md.
//
// The lock is a PostgreSQL session advisory lock keyed on the account, held on
// a connection of its own outside any transaction. The operation keeps using
// `db` with its own short transactions; no row lock is held across a Toss
// call. A lock belongs to its connection, so a process that dies releases it
// at once — there is no lease to go stale.
//
// Session locks need a direct connection. A transaction-pooling proxy
// (PgBouncer in transaction mode) in front of DATABASE_URL would hand the lock
// and the unlock to different sessions; don't put one there.

// The advisory lock's first key: payments' own key space, so no other user of
// advisory locks can collide with it. The second key is hashtext(user id); two
// accounts whose ids collide only wait for each other.
export const PAYMENTS_LOCK_SPACE = 0x50415931; // "PAY1"

// Separate from the app's pool, so connections pinned while a Toss call is in
// flight can never starve sign-in or the data API. A pool with none free is
// the same as a busy account.
const LOCK_POOL_MAX = 5;

let lockPool: Pool | null = null;

function pool(): Pool {
  lockPool ??= new Pool({
    connectionString: process.env.DATABASE_URL,
    max: LOCK_POOL_MAX,
    connectionTimeoutMillis: 2000,
    // A half-open connection would hold its lock until noticed.
    keepAlive: true,
    keepAliveInitialDelayMillis: 10_000,
  });
  return lockPool;
}

// For tests and scripts that end the process themselves.
export async function closeAccountLockPool(): Promise<void> {
  const current = lockPool;
  lockPool = null;
  await current?.end();
}

export class AccountBusyError extends Error {
  constructor(public readonly userId: string) {
    super(`Account ${userId} has another payment operation in progress`);
    this.name = "AccountBusyError";
  }
}

// The accounts locked in the current async context, so an operation that
// calls another for the same account (a card change charging the renewal it
// unblocked) runs it inside the lock it already holds.
const held = new AsyncLocalStorage<Set<string>>();

// Runs fn as if from another process: none of the current context's account
// locks count as held inside it. For tests that act as a second process
// (the reconciler running while a charge is in flight).
export function runOutsideAccountLocks<T>(fn: () => Promise<T>): Promise<T> {
  return held.exit(fn);
}

export function holdsAccountLock(userId: string): boolean {
  return held.getStore()?.has(userId) ?? false;
}

// Runs fn while holding the account's lock. waitMs 0 tries once; otherwise
// waits up to waitMs for another operation on the account to finish. Throws
// AccountBusyError when it does not get the lock in time.
export async function withAccountLock<T>(
  userId: string,
  opts: { waitMs: number },
  fn: () => Promise<T>,
): Promise<T> {
  if (holdsAccountLock(userId)) return fn();

  let client: PoolClient;
  try {
    client = await pool().connect();
  } catch {
    throw new AccountBusyError(userId);
  }

  let locked = false;
  let broken = false;
  try {
    locked = await acquire(client, userId, opts.waitMs);
  } catch (error) {
    broken = true;
    client.release(true);
    throw error;
  }
  if (!locked) {
    client.release();
    throw new AccountBusyError(userId);
  }

  const accounts = new Set(held.getStore() ?? []);
  accounts.add(userId);
  try {
    return await held.run(accounts, fn);
  } finally {
    try {
      await client.query("select pg_advisory_unlock($1, hashtext($2::text))", [
        PAYMENTS_LOCK_SPACE,
        userId,
      ]);
    } catch {
      // A connection that cannot say it unlocked must not go back to the pool
      // still holding the lock; destroying it drops the lock with it.
      broken = true;
    }
    client.release(broken);
  }
}

async function acquire(
  client: PoolClient,
  userId: string,
  waitMs: number,
): Promise<boolean> {
  if (waitMs <= 0) {
    const result = await client.query<{ locked: boolean }>(
      "select pg_try_advisory_lock($1, hashtext($2::text)) as locked",
      [PAYMENTS_LOCK_SPACE, userId],
    );
    return result.rows[0]?.locked === true;
  }
  // lock_timeout bounds the wait; it is reset before the connection goes back
  // to the pool either way.
  await client.query(`set lock_timeout = ${Math.trunc(waitMs)}`);
  try {
    await client.query("select pg_advisory_lock($1, hashtext($2::text))", [
      PAYMENTS_LOCK_SPACE,
      userId,
    ]);
    return true;
  } catch (error) {
    if ((error as { code?: string }).code === "55P03") return false;
    throw error;
  } finally {
    await client.query("set lock_timeout = 0");
  }
}
