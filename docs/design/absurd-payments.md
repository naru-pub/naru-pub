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

The existing background `worker` process runs Absurd's SDK worker alongside
Fedify. It polls every 0.5 seconds and executes at most four tasks concurrently,
claiming one task at a time only when capacity is available. The 600-second
claim permits several 90-second Toss requests without holding claims for tasks
waiting in a local batch. The SDK owns polling, capacity, claims and draining.

SIGTERM/SIGINT stop both listeners, wait for claimed work and heartbeat calls,
then close the databases. Compose allows five minutes for this shutdown, matching
the deployment script. Process death still leaves durable tasks for Absurd's
lease recovery. If either listener exits, the process stops and drains the other
before closing shared resources, and the service restart policy restarts it.

pg_cron enqueues an `enqueue_due_renewals` Absurd task hourly. The continuous
payment worker scans due subscriptions and enqueues their individual renewal
tasks. A UTC-hour idempotency key merges repeated triggers and deployment
catch-up; subscription-level keys still prevent duplicate charges. The remaining
reconciliation and maintenance schedules also spawn durable tasks, on a separate
maintenance queue. The application cron service and its
queue-draining subprocess have been removed. See [the full migration](cron-replacement.md).
No new broker, service, or queue implementation is required. `runDueJobs` remains
an integration-test helper; source checks prohibit production batch drains.

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
HTTP returns 202 after acceptance and never cancels at Toss. Refund execution is
private to the registered Absurd handler in `payment-jobs.ts`; there is no public
refund executor. Integration and chaos tests use claimed Absurd tasks too. The same authenticated
endpoint exposes read-only progress; the payment-history UI polls until the
ledger confirms a refund or the task stops. Repeated requests return the accepted
intent without another task or another policy check. The durable task can
finish it after a crash or ambiguous result, including after the seven-day
policy deadline. Recovery skips a payment already refunded and stops only
the captured subscription. Reconciliation uses the same captured identity;
dashboard refunds continue to use the provider's cancellation time.
Accepted refunds block renewal charges of the captured plan while unsettled.
Account deletion retains an anonymized user tombstone and the financial graph.
Accepted refunds and other durable work continue after deletion; credentials,
sessions, account content, and entitlements are removed. Financial foreign keys
restrict deletion, and the database rejects new payment intents for tombstones.

## Card-change renewals

A due renewal is spawned in the same transaction that swaps the billing key and
completes its card registration, deduplicated by registration id. HTTP returns
that the card changed and its renewal is queued. The worker verifies that the
completed registration still owns the subscription's current key, rechecks that
the plan is due, and retries declined orders on the new card. A canceled plan or
superseded registration cannot charge. Ordinary scheduled renewals keep their
existing daily cutoff and retry spacing; card-change tasks explicitly bypass
that spacing. Billing-key registration and deletion retain their existing paths.


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

## Initial subscription charges and recovery

Adopting a signup's key commits its payment order and initial-charge task in
one transaction (or schedules the plan behind existing paid time). HTTP returns
202 for a queued charge. Repeated callbacks reuse the order and task; only the
Absurd handler sends the charge. It rechecks the plan/key identity and unsent
orders wait behind paid time acquired after acceptance. Ambiguous responses
retry the same order; a declined payment is a business outcome, not a failed task.

The operator payment page lists pending, retrying and failed tasks, their most
recent error, and next run time. A reason is required to retry a failed task.
`absurd.retry_task` extends the original task's attempt budget without replacing
its parameters, checkpoints or idempotency key. Task recovery and the operator's
identity/reason audit event commit together. Recovery never executes money in HTTP.

## One-time approvals and lab renewals

The one-time callback validates the authenticated user's stored order and amount,
then commits `toss_payment_key` and a deduplicated `confirm_one_time` task together.
It returns 202 with the payment ID; the callback opens `/support` with a
processing modal that polls the owner-only, uncached payment status endpoint.
The modal displays completion, failure, scheduled start, or operator attention
and refreshes the support status on a final result. Transient connection errors keep polling;
closing the modal stops polling without canceling durable work. Repeated
callbacks reuse the task and cannot replace its provider key. The ledger, rather
than task params, supplies the key, order ID and amount to the executor.

Reconciliation remains a lookup and facts applicator. Finding an authenticated
`IN_PROGRESS` one-time order enqueues the same approval task; it never approves
inline during signup, purchase preparation, deletion or a sweep. An accepted
pending order blocks a new purchase even if its provider lookup is unavailable.
The executor rechecks account eligibility under its lock before sending; after
an ambiguous send it checks Toss first, so an approved order is applied once
rather than charged again. Unsent superseded orders expire without a charge.
Only verified provider facts grant paid time.

The billing lab changes the renewal date and enqueues `renew_subscription` in
one transaction. Its forced error code travels with the task and is applied
only in Toss test mode. Results appear in payment history and the task list;
the lab response is acceptance, not an execution trace. The old inline renewal
runner has been removed. Source boundary tests guard approval, charge and refund
call sites and the renewal executor's only production caller.

## Refunded prepaid allocations

Refund facts use TypeScript in `paid-time.ts` to compact periods queued directly
behind the refunded allocation,
preserving each remaining purchase's granted duration. Independent purchases
after a gap keep their dates. Money records and provider transaction history
remain; the ledger's service allocation dates reflect the corrected schedule.
`paid_time_revoked_at` makes revocation idempotent across retries and incremental
provider cancellations. The migration repairs historical stacked refunds and
skips overlapping replacement purchases whose old refund already reduced access.
The entitlement projection and remaining subscription due date can only move
backward during refund application.

The original historical repair stays frozen in its migration. A forward migration
removes the SQL compaction function; ongoing refunds use TypeScript and Kysely
in the existing account-locked transaction.

## Account content deletion

Account deletion discovers cascade and set-null foreign keys through TypeScript
and Kysely in the same transaction as the user tombstone. Database cascades still
remove dependent content, while restrictive financial references and unfinished
Absurd tasks remain. Anonymization and live-account guards stay in database
triggers. The SQL content-erasure function and unused legacy UUID helpers are
removed. The legacy mapping table was already retired after storage conversion.

Subscription billing fields use immediate `CHECK` constraints: canceled plans
hold neither a key nor a billing date, and active or scheduled plans have both.
Cancellation and card replacement update the subscription atomically before
retiring its old key. Account deletion ends its plan before retiring other keys.
The cross-table active-key guard remains a deferred database trigger.
