# Replacing the application cron service

The application cron service can be removed completely. PostgreSQL's pg_cron
remains the clock; Absurd owns durable execution, retries and recovery. This
follows [Absurd's cron pattern](https://earendil-works.github.io/absurd/patterns/cron/).
It does not remove the need for a scheduler or a running worker.

## Implemented: subscription renewal scans

An hourly pg_cron command spawns `enqueue_due_renewals` in the payments queue.
The continuous worker scans subscriptions and transactionally spawns their
individual renewal tasks. Schedule triggers and deployment catch-up share a
UTC-hour idempotency key. The existing 09:00 KST cutoff, account locks and
subscription-level deduplication still apply. Deployment updates the named
schedule in pg_cron's configured metadata database, targeting the application
with `cron.schedule_in_database`. Payment execution stays in Absurd.

## Remaining time-based jobs

These jobs still run in `src/cli/cron.ts`. All can use the same pg_cron-to-Absurd
pattern. Times below are UTC; the corresponding existing daily times are KST.

| Job | Schedule |
| --- | --- |
| screenshot-updater | Every 15 minutes |
| export-processor | Every 2 minutes |
| site-update-dispatcher | Every 5 minutes |
| custom-domain-refresher | Every 3 minutes |
| payment-reconciliation | Every 5 minutes |
| billing-key-deletion | Every 5 minutes |
| payment-event-digest | Every minute |
| github-deployment-cleanup | Every 15 minutes |
| media-cleanup | Every 15 minutes |
| site-data-grant-cleanup | Every 30 minutes |
| home-directory-updater | 13:00 (22:00 KST) |
| payment-refund-sync | 19:15 (04:15 KST) |
| billing-notifications | 00:00 (09:00 KST) |
| expired-custom-domain-cleanup | 19:30 (04:30 KST) |
| toss-transaction-check | 19:45 (04:45 KST) |
| payment-invariant-check | 20:00 (05:00 KST) |

Use a separate maintenance queue and bounded worker capacity. Screenshot,
export and home-directory tasks can run for tens of minutes; they must not take
payment slots and delay time-sensitive approvals. Extract callable functions
from CLI entry points before registering handlers; importing a CLI that starts
itself or exits the process is unsafe. Preserve existing timeouts, operational
run records and alerts. Use schedule-slot idempotency keys and define overlap
behavior per job: slot deduplication alone does not prevent two different slots
running concurrently. Domain operations must remain safe when execution retries
after interruption.

## Event-driven work and monitoring

Cron also listens for `board_template_published` and renders template previews.
Replace both publishing transactions' `pg_notify` calls with transactional
Absurd enqueueing. Keep the periodic screenshot sweep as repair for missing
previews. Durable enqueueing replaces the listener's reconnect loop and
in-memory running/queued flags.

Move cron's process heartbeat, stalled-job checks and external
`CRON_HEARTBEAT_URL` ping to the worker. Preserve an external monitor for whole
server outages. Derive failure and recovery alerts from durable task/run state;
the current process-local alert suppression must not become the new source of
truth. Existing `payment_cron_runs` history can be retained despite its name.

Remove the cron Compose service and deployment lifecycle only after the remaining
handlers, schedules, template enqueueing and monitoring have moved. Renewal
scheduling alone does not yet make that service redundant. No additional
application-owned durable queue or scheduler is needed.
