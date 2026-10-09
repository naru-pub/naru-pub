# Hosted-site pageview analytics

## Metric and eligibility

A pageview is a successful HTML GET navigation to a top-level document that
reaches Naru's edge Worker (`edge/src/pages.ts`), which serves every hosted
site. It is not proof of a human visitor, a count of SDK calls, or a count of
offline/cache-only page displays. The same rule applies to every site,
including custom domains, without path/referrer/username rules.

The Worker classifies successful HTML responses using Fetch Metadata:

| Request                                                     | Treatment  |
| ----------------------------------------------------------- | ---------- |
| GET, `Sec-Fetch-Mode: navigate`, `Sec-Fetch-Dest: document` | Record     |
| Anything else                                               | Not logged |

Redirects, failed responses, and non-HTML files never enter this pipeline.
Clients that send no metadata deliberately do not count; this loses older
clients/crawlers but prevents treating arbitrary fetches as visits. Headers can
be forged by non-browser clients, so this is classification rather than bot
protection. No `Sec-Fetch-User` requirement: automatic document navigation
still counts. No time-based deduplication of visits: legitimate reloads count.
There are no frame, background or unknown counters.

## Ingestion

Path, referrer, and user-agent are capped at 2,048 UTF-8 bytes. A navigation
is appended, after the response is sent, to the Worker's pageview log
(`edge/src/pageview-log.ts`), one Durable Object. Serving a site never waits
for or depends on recording analytics.

The `edge-pageview-drain` maintenance job runs every minute. It takes the
oldest thousand events at a time into the transaction below, then tells the
log to forget them. The batch's last id is stored in `edge_pageview_cursors` in
the same transaction, so a batch handed out again after a lost acknowledgement
is skipped, not counted twice. Nothing is dropped while PostgreSQL or the whole
host is down: the log keeps up to six million events, dropping the oldest past
that, and they are counted when the control plane is back. The job fails, and
so alerts the operator through the ordinary job-failure alert, while the oldest
waiting pageview is more than 30 minutes old.

## Atomic writes and daily visitors

The event captures its UTC request time when the Worker receives the request,
so a midnight crossing or a delay in the log does not move it to another day.
One transaction per batch, with a 30-second statement timeout, does for each
event:

1. Insert `(user_id, UTC date, ip)` into `pageview_daily_visitors`, ignoring
   conflicts on its unique constraint.
2. Insert the raw pageview with the captured timestamp.
3. Increment daily views; increment daily unique visitors only if step 1
   inserted a row.

and then records the batch's last id and commits. Concurrent first visits
serialize through the unique constraint. Any error rolls back the entire batch,
which the next run takes again. A visitor is still an IP, not a person; shared
IPs merge visitors and changing IPs split them. Multi-day unique totals remain
the existing sum of daily visitors, not distinct people over the whole period.

The visitor table uses a UUIDv7 primary key and a date/id retention index.
Its migration seeded that day's visitor keys from existing rows to avoid
recounting existing IPs on cutover, without rewriting historical totals.

## Retention and query compatibility

A durable maintenance job runs every 15 minutes, removing events and visitor
keys before UTC midnight 35 days ago. Each transaction removes at most 1,000
rows with `SKIP LOCKED`; each run removes at most 100,000 rows per table. Large
initial backlogs drain over successive runs. Existing daily totals remain
indefinitely, preserving `지금까지의 조회` at its accumulated value; new
accepted navigations continue incrementing it. Lifetime counts and historical daily graphs survive cleanup.
Thirty-day path, referrer, and browser reports still use recent raw events.
No partitioning or additional dimension rollups are needed for this change.

Existing raw events lack Fetch Metadata and cannot be accurately reclassified.
We retain their recorded meaning until they age out; historical aggregates
remain legacy HTML-request counts. There is no site-specific correction or
bulk deletion during migration. Retention changes storage policy for all sites.

## Validation

Regenerate db.d.ts from a fully migrated disposable database. Validate request
classification, duplicate batches after a lost acknowledgement, concurrent
same-IP writes, atomic rollback, UTC date handling, and retention preserving
recent rows/daily totals against disposable PostgreSQL. Already expired raw
events are not recoverable by a migration rollback.
