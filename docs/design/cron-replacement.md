# Replacing the application cron service

The application cron service has been removed. PostgreSQL's pg_cron
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

## Durable maintenance jobs

These jobs are registered in `lib/maintenance/jobs.ts` and run through
`maintenance-job-v1` in the separate `maintenance` Absurd queue. Times below are UTC; the corresponding existing daily times are KST.

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

The continuous worker runs payment and maintenance consumers separately, each
with four execution slots. Maintenance handlers use bounded child-process
adapters for the existing compiled CLI entry points; CLI exits and Chromium
stay isolated. Original timeouts and payment run history are preserved.
The worker renews maintenance leases every 30 seconds while scripts run.

PostgreSQL session advisory locks serialize each job across slots and worker
replicas. Template previews share the screenshot sweep's lock. Busy tasks sleep
through Absurd rather than overlap. Failure retries are bounded to eight attempts
with exponential backoff. Cancellation or a lost heartbeat stops the entire CLI
process group before releasing its lock. Shutdown interrupts maintenance scripts
and returns their tasks to Absurd retry, while payment tasks finish draining.
These jobs remain at-least-once operations; the queue cannot make external
side effects exactly once. Existing domain idempotency and account locks remain
necessary on retry after an interrupted attempt.

## Schedule configuration and catch-up

`configure-schedules.ts` atomically updates all named pg_cron schedules in its
metadata database with `cron.schedule_in_database`. It validates UTC/GMT,
removes retired schedules only from our maintenance namespace in the target
database, registers monitoring rows and enqueues one catch-up task per current
slot. Periodic slots use their interval; daily slots begin at the scheduled UTC
time, so catch-up before that time belongs to yesterday's run. Daily slots are
also probed hourly at their scheduled minute: probes dedupe on normal days and
recover a missed run within an hour after a database outage. Already queued
work and unrelated pg_cron jobs are retained. Historical `payment_cron_runs`
records keep their existing name and retention policy. The minute digest task
uses Absurd's built-in cleanup to prune terminal maintenance tasks after 30 days;
unfinished tasks and the payment queue are preserved.

## Event-driven work and monitoring

Both template-publishing transactions now enqueue a preview task keyed by the
version ID. Rollback removes the publication and its task together. The
15-minute screenshot sweep remains repair for missing previews; no LISTEN,
reconnection loop or process-local preview flags remain.

The worker records its heartbeat, checks stalled jobs and sends the existing
external `CRON_HEARTBEAT_URL` ping. Failure/recovery notification state lives in
`cron_jobs`, and alert delivery failure rolls back the notification mark so the
next heartbeat retries. A database trigger records terminal maintenance failures,
including exhaustion during lease recovery when no handler completed.
The external monitor detects whole-worker/server outages.

Deployment stops and removes the retired cron container before migration,
then uses the worker image for migrations and schedule configuration. Ordinary
schema-compatible releases keep the HTTP slot serving. Unfinished payment and
maintenance tasks stay in PostgreSQL. No application-owned durable queue or
scheduler has been introduced.
