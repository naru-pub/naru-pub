# One money operation per account at a time

Status: proposal, not implemented. 2026-10-01.

## Problem

Four review rounds of the Toss payment code each found new bugs, and most of
them were the same kind: two operations on one account interleaving.

- the reconciler expiring an order while a renewal was charging it;
- a one-time purchase switching a plan off while its renewal was being charged;
- a card change's own reconciliation clearing the lease it held;
- account deletion while a charge was in flight;
- refund paths clearing a lease a charge still held;
- a doubled signup callback deleting the key it had just stored;
- `markPastDueAfterGrace` overwriting a plan the reconciler had just paid.

Today mutual exclusion comes from `subscriptions.charging_started_at`, a lease
written as a timestamp. It is advisory: each path checks it at its own moment,
with its own idea of when a lease is stale (30 minutes, while Toss lets an
authenticated payment wait only 10). Paths that do not hold the lease have to
check it, and paths that end a plan must not clear it. Every new rule has to be
repeated in every writer — about 15 of them — and each fix so far has added a
guard rather than removing an interaction.

## Goal

For any one account, at most one operation that can move money or change its
billing state runs at a time, across web requests, cron jobs and both
blue/green slots. A crashed holder releases at once, with no staleness window.
Operations on different accounts stay fully parallel.

Not a goal: removing reconciliation. Toss outcomes can be ambiguous no matter
how we lock (a charge that times out may still be approved), so the order-level
safety — an order row before every call, the order id as idempotency key,
looking an order up before calling it failed — stays exactly as it is.

## Mechanism: a session advisory lock per account

```ts
await withAccountLock(userId, { waitMs: 5000 }, async () => {
  // ...the whole operation, including its Toss calls...
});
```

- **Lock.** `pg_advisory_lock(PAYMENTS_LOCK_SPACE, hashtext(user_id::text))`,
  the two-key form, so payments has its own key space. A hash collision
  between two users only makes them wait for each other; it is harmless.
- **Held on a pinned connection, outside any transaction.** The helper checks
  a client out of a small dedicated pool, takes the lock, runs `fn`, unlocks
  and returns the client. `fn` keeps using `db` normally, with its own short
  transactions on other connections. No transaction or row lock is held across
  a Toss call, just as now.
- **Crash = release.** A session advisory lock belongs to the backend
  connection. If the Node process dies or is killed, the socket closes and
  Postgres drops the lock immediately. If unlocking fails, the helper destroys
  the client (`release(true)`) instead of returning it to the pool with the lock
  still held.
- **Waiting.** The lock is taken with `SET lock_timeout = <waitMs>` on the
  pinned connection. A timeout (SQLSTATE 55P03) raises `AccountBusyError`, which
  each caller turns into its own answer (below). `waitMs: 0` uses
  `pg_try_advisory_lock`.
- **Reentrancy.** An `AsyncLocalStorage` set of the account ids held in the
  current async context; a nested `withAccountLock` for the same account runs
  `fn` directly. A card change charging the overdue renewal inside its own lock
  is the case that needs it.
- **Dedicated pool.** `max: 5`, separate from the app's 20, so pinned
  connections can never starve sign-in or the data API. The pool being
  exhausted counts as busy.
- **Keepalive.** Turn on `keepAlive` for the lock pool, so a half-open
  connection (rare, since Postgres runs on the same host) is noticed in seconds
  rather than hours.

Production connects straight to Postgres (`host.docker.internal`, no
PgBouncer), so session locks behave as described. A transaction-pooling proxy
added later would break this; that should be written down beside the pool.

## Which operations take it

Everything that can charge, refund, issue or retire a billing key, or change a
subscription's status or dates. The key is the account (`user_id`), because
there is one subscription per account, and one-time payments belong to the
account too.

| Operation | Wait | When busy |
| --- | --- | --- |
| Signup prepare / confirm (`subscription-signup.ts`) | 5 s | 409 "결제를 처리하고 있습니다" (callback retries on 503, so confirm answers 503) |
| Card change prepare / confirm, including its immediate charge | 5 s | as above |
| One-time prepare (settles earlier orders) | 5 s | 409 |
| One-time confirm (callback route) | 5 s | 503; the callback retries, inside Toss's 10 minutes |
| Renewal, per subscription (`subscription-renewals.ts`) | 0 | skip this account this run |
| Reconciler, per payment (lock on its `user_id`) | 0 | skip; the next run gets it |
| Refund acceptance (`requestRefund`: record intent + Absurd task) | 10 s | 409 "잠시 후 다시 시도" |
| Refund execution (private Absurd handler: cancel → apply/reconcile → stop captured plan) | 0 | Absurd durably sleeps on contention |
| Cancel route | 10 s | 409 |
| Webhook reconcile (`PAYMENT_STATUS_CHANGED`) and `BILLING_DELETED` | 5 s | 503; Toss retries |
| Account deletion: the settle-and-cancel step and `deleteUserRow` | 10 s | 409 |
| Orphan recovery (`recoverOrphanedCharge`) | 10 s | 409 |
| Billing lab actions | 10 s | error shown in the lab |

Not locked, since they never change an account's billing state: the key
deletion queue (keys there are already retired, and it checks no subscription
holds them), the digest, renewal notices, and refund-sync's choice of rows
(each row's reconcile takes the lock).

The longest hold is a signup confirm or a renewal during a Toss outage: up to
three 90-second calls. Today a web request already waits that long, so the lock
adds no new latency; it only makes a second operation on the same account wait
or step aside.

## What it removes

Once every writer holds the lock (phase 2 below), these exist only to stand in
for it and can go:

- `subscriptions.charging_started_at` and `CHARGE_LEASE_MINUTES`;
- `claimSubscriptionForConfirm`, `releaseSubscriptionLease`, `renewLease`,
  `releaseLease`, the lease half of `stillChargeable`;
- `chargeInFlight` in the reconciler's expiry, `leaseHeldAt` on
  `reconcilePayment` and `applySuccessfulCharge`, `ownsLease` on
  `retireUnusedSignupKey`;
- `subscriptionChargeInFlight` and the waits built on it;
- `ChargeInFlightError` in account deletion;
- the stale-lease conditions in `prepareSubscription`'s reset and in the
  renewal claim;
- the "only the holder clears it" rules and their comments.

The renewal claim becomes a plain query for due subscriptions, each charged
inside its account's lock.

## What stays

- Order safety: an order row before every Toss call, order id as idempotency
  key, look up before failing, reconcile ambiguity later.
- One new piece the lock cannot replace: **expiry measured from the last charge
  attempt**, not the order's creation. A charge that timed out may still be
  approved by Toss after the lock is released, so an order Toss has not heard
  of is expired only 45 minutes after its last attempt (a
  `payments.charge_attempted_at` column, set just before each charge or confirm
  call). This is round 4's finding #1, and it is needed with or without the
  lock.
- The ledger recompute, the refund rules (`plan_started_at`,
  `refund_keeps_plan`), the superseded-one-time check (race-free once confirms
  are serialized), and the key-deletion guard.

## Findings it makes structurally impossible

From the four rounds, each of these needed its own fix and would not have been
possible under the lock: reconciler expiry under a charge; one-time approval
during a renewal (both the check-then-act gap and the crashed-lease 30-minute
block); card change failing after its own reconcile granted a renewal; account
deletion during a charge; stop paths clearing a live lease; renewal batches
running on stale leases; `markPastDueAfterGrace` acting on a stale copy; a
doubled signup callback re-issuing and discarding its own key; a cancel racing
a scheduled plan's first charge.

What it does **not** fix: ambiguous Toss outcomes (still reconciled), wording
and UX problems, the cron time zone, missed daily runs, email retries, and
logic errors inside a single operation. Those are ordinary bugs that a
reviewer can check one function at a time, rather than every pair of
functions.

## Rollout

Each phase ships on its own and is safe to deploy blue/green.

1. **Add the lock alongside the lease.** `withAccountLock` with tests; wrap
   every operation in the table; add `charge_attempted_at` and move expiry to
   it. Keep all lease code. During the deploy, old code (lease only) and new
   code (lock and lease) run together, and the lease still protects the mix.
2. **Remove the lease**, once phase 1 is the only code running (the old slot is
   gone). Delete the code listed above and the tests that exercised lease
   timing. Keep the column for one release.
3. **Drop `charging_started_at`** in a later migration.

A rollback during phase 2 to phase 1 is safe, since phase 1 holds both. A
rollback past phase 1 needs the old slot's lease writes, which phase 2's code
no longer makes; a rollback only switches the web slot, so
note that phases 1 and 2 should not go out back to back.

## Tests

Against the real database (`pnpm test:payments:db`), with Toss mocked by
promises the test resolves by hand:

- two operations on one account run one after the other: start a renewal whose
  charge is held open, start a one-time confirm, and check the confirm answers
  busy or waits until the charge settles;
- operations on two accounts overlap;
- the lock is released when `fn` throws, and when the backend is killed
  (`pg_terminate_backend` on the pinned connection's pid);
- re-entry for the same account in one async context does not deadlock;
- a busy account is skipped by the renewal run and the reconciler, then handled
  on the next run;
- pool exhaustion turns into `AccountBusyError`, not a hang.

The existing tests that wedge leases by hand (`charging_started_at = now()`)
become tests that hold the account lock from a second connection.

## Cost and risk

- **Effort.** Phase 1: about two days (the helper and its tests, wrapping
  roughly fifteen call sites, `charge_attempted_at`). Phase 2: about a day,
  mostly deleting code and rewriting the lease-timing tests. Net, the code
  shrinks.
- **Contention.** Only one account's own operations ever wait, and only while
  one of them is running. The visible case is a supporter acting at the moment
  their renewal is being charged: they get "처리하고 있습니다" for up to a
  minute or so.
- **Connections.** At most five pinned at once, from their own pool. A sixth
  concurrent payment operation is told the account is busy and retries.
- **Mistakes in coverage.** A writer left outside the lock is the one way back
  to today's bugs. Phase 2 makes this checkable: after it, `updateTable(
  "subscriptions")` and the Toss money calls should appear only inside
  functions that take the lock, which a test can assert the way
  `billing-key-writes-payment.test.ts` asserts key writes today.

## Alternatives considered

- **Hold row locks (`SELECT … FOR UPDATE`) across the Toss call.** Gives the
  same exclusion but keeps a transaction open for up to 90 seconds, holding row
  locks that block ordinary reads and writes on the user and subscription.
  Rejected.
- **A job queue: one worker per account.** The strongest isolation, and web
  requests could return at once. But it needs queue infrastructure (the only
  worker today is Fedify's), changes every flow to asynchronous with polling in
  the browser, and adds a new place for jobs to get stuck. More than this
  problem needs.
- **Keep the lease, centralize it.** One module owning the lease would remove
  the copy-paste, but not its time-based staleness, which is where the
  10-minute vs 30-minute and crashed-holder bugs come from.

## Open questions

- Wait times and messages per operation: are 5 seconds for callbacks and 10 for
  explicit actions right, and is the copy right?
- Renewals skipping a busy account rely on a later run picking it up. Today
  there is one run a day, so this lands together with round 4's hourly renewal
  run (one try per subscription per day).
- Should the invariant monitor (a nightly query for rule-breaking rows, raised
  as a payment event) ship with phase 1? It catches coverage mistakes in
  production.
