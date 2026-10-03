# Payment execution with Absurd

The payment queue uses Absurd 0.5.0, pinned in `control-plane/package.json`.
Its Apache-2.0 SQL schema is vendored from the matching release in
`control-plane/src/migrations/vendor/absurd-0.5.0.ts`. The TypeScript string
preserves the upstream SQL and bundles into the jobs image. Upgrades belong
in new Kysely migrations, using the upstream versioned migration SQL.

## Ownership

Absurd owns task deduplication, claims, checkpoints, retry backoff, and durable
sleeps. Application tables still own subscriptions, orders, money, billing
keys, and entitlements. Account locks and ledger uniqueness remain necessary:
a crashed worker can have sent a Toss request without recording a checkpoint,
and workers can overlap after their leases expire.

`enqueueJob(executor, job)` calls the public `absurd.spawn_task` SQL function
on its supplied Kysely executor. Enqueueing inside a business transaction is
atomic; using an SDK client on another pool connection would not be.
`payment-job-v1` executes one domain operation in the `perform` checkpoint.
Busy accounts durably sleep for a minute without consuming a failure retry.
Successful work and contention are checkpointed; other errors retry. Pending money outcomes
remain in the payment ledger and are revisited by the existing reconciliation
and refund sweeps.

The existing minute cron invokes `run-payment-jobs.ts`, which uses Absurd's
SDK to claim and execute at most 50 tasks, one at a time. A 600-second claim
allows several 90-second Toss requests without claiming other tasks in advance.
Web requests only enqueue; notifications may arrive on the next minute run.
The hourly subscription producer also drains a batch after enqueueing renewals.
No new broker, service, or queue implementation is required.

## Applying provider facts

`payment-facts.ts` exposes `applyVerifiedTossPayment(paymentId, response)`.
Charge/confirm responses, cancellation responses, and reconciliation lookups
all use it; webhooks still trigger a server-side lookup rather than applying
untrusted webhook bodies. Purchase kind, amount and billing interval come
from the recorded order and subscription.

One database transaction locks the current payment, validates the order id,
amount and existing provider identity, records provider metadata and ledger
entries, updates the subscription and paid time, records events, and spawns
notification tasks. Duplicate approvals do not extend access or enqueue another
receipt. Older unpaid/approval observations cannot undo a recorded refund, and
older cancellation snapshots cannot reduce the accumulated refund ledger.

Renewal declines apply provider facts inside the transaction that updates their
retry policy. Definitive declines with no provider order and local expiry of
orders Toss never saw remain policy decisions in their existing producers.
External calls, key deletion and email delivery happen outside this transaction.
A successful refund response is applied directly; uncertain cancellation results
still use reconciliation. The account locks, database constraints and recovery
sweeps continue to protect operations around the provider call.

## Refund recovery

Acceptance commits `payments.refund_requested_at`, the specific
`refund_subscription_id`, and a deduplicated refund task before calling Toss.
The HTTP request still attempts the refund immediately. The durable task can
finish it after a crash or ambiguous result, including after the seven-day
policy deadline. Recovery skips a payment already refunded and stops only
the captured subscription. Reconciliation uses the same captured identity;
dashboard refunds continue to use the provider's cancellation time.

An external call can repeat before its checkpoint commits. Full cancellations
are reconciled if Toss reports them already canceled. Approval facts and
entitlements retain their existing transactional idempotency. Email delivery
can repeat if the mail provider accepted a message before a crash; a checkpoint
alone cannot eliminate that external uncertainty.

## Deployment

Downtime is acceptable and backward compatibility is not required. This is a
repository-wide preference recorded in `AGENTS.md`.

Ordinary deployments keep the active web slot serving while background
processes stop and compatible migrations run. Breaking migrations use
`DEPLOY_DOWNTIME=1 ./deploy.sh`, which stops both web slots as well. The Absurd
queue adoption required this breaking cutover: it imports unfinished jobs, schedules,
remaining retry budgets, and terminal deduplication history, then drops
`payment_jobs`. Claims left by stopped workers do not delay the cutover. No
compatibility trigger or legacy queue remains.

The new application starts after migration, passes health checks, and resumes
background processing. This migration is forward-only: fix failures by deploying
compatible current code, preserving durable tasks and payment records. Older web
images that use the dropped table cannot be rolled back into service.

Keep workflow names and checkpoint structure stable while tasks are outstanding.
For incompatible changes, introduce another task version, deploy its handler
before producers, and retain the old handler until its tasks drain.

Absurd queue history is retained indefinitely for now, including spawn dedupe keys.
Do not enable cleanup without defining how business deduplication survives it.
Inspect `absurd.t_payments` and `absurd.r_payments` for task/run state; terminal
failures generate existing `job_failed` events in the same database commit,
including failures discovered when reclaiming a dead worker's final attempt. PostgreSQL backups
must include the `absurd` schema.

## Validation

`pnpm test:payments:db` runs against a disposable migrated PostgreSQL cluster.
It covers atomic enqueue rollback, legacy job import, scheduled work, repeated
contention, abandoned claims, checkpoint replay, refund recovery after request
death, and preservation of a later signup. Existing payment and chaos tests
continue to validate the ledger and entitlement invariants.
