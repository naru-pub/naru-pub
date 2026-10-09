# Hosted-site pageview analytics

## Metric and eligibility

A pageview is a successful HTML GET navigation to a top-level document that
reaches Naru's hosted-site proxy. It is not proof of a human visitor, a count of
SDK calls, or a count of offline/cache-only page displays. The same rule applies
to every site, including custom domains, without path/referrer/username rules.

The proxy classifies successful HTML responses using Fetch Metadata:

| Request                                                     | Treatment               |
| ----------------------------------------------------------- | ----------------------- |
| GET, `Sec-Fetch-Mode: navigate`, `Sec-Fetch-Dest: document` | Record                  |
| GET navigation to `iframe` or `frame`                       | Frame counter only      |
| GET with either metadata header absent/unreadable           | Unknown counter only    |
| Other methods or other mode/destination combinations        | Background counter only |

Redirects, failed responses, and non-HTML files never enter this pipeline.
Unknown clients deliberately do not count; this loses older clients/crawlers
but prevents treating arbitrary fetches as visits. Headers can be forged by
non-browser clients, so this is classification rather than bot protection.
No `Sec-Fetch-User` requirement: automatic document navigation still counts.
No time-based deduplication of visits: legitimate reloads count.

## Bounded ingestion

Each proxy process has a 256-event FIFO and one persistence worker using a
separate pool limited to one connection. Routing retains its five-connection
pool. Enqueue never waits; full/closed queues drop analytics, not the served
response. Path, referrer, and user-agent are capped at 2,048 UTF-8 bytes, so
queued payloads cannot grow with arbitrary header/path lengths. There are no
per-request analytics tasks and no retries that amplify an outage.

Every 60 seconds the proxy logs interval counts of recorded, dropped, failed,
frame, background, and unknown events. Operators can ingest these logs into
monitoring and alert on sustained drops/failures or abrupt traffic changes.
This implements observable counters, not an external alerting integration.
Analytics are best effort: a process exit can lose queued events; database
failures drop an event. Serving a site must not depend on recording analytics.

### Sites served at the edge

Sites the edge Worker serves (`EDGE_SITES`, see
[deployment](../deployment.md#hosted-sites-at-the-edge)) are classified the same
way in `edge/src/pages.ts`, with the same 2,048-byte caps. A
navigation is appended to the Worker's pageview log, one Durable Object, after
the response is sent. The `edge-pageview-drain` job takes the oldest thousand
events at a time into the transaction below, then tells the log to forget them.
The batch's last id is stored in `edge_pageview_cursors` in the same
transaction, so a batch handed out again after a lost acknowledgement is
skipped, not counted twice. Unlike the proxy's queue, nothing is dropped while
PostgreSQL or the whole host is down: the log keeps up to six million events,
dropping the oldest past that. The edge keeps no frame, background or unknown
counters.

## Atomic writes and daily visitors

The event captures its UTC request time before origin fetching/enqueue, so a
midnight crossing does not move it to another day. One transaction, with a
five-second statement deadline and three-second pool acquisition timeout:

1. Insert `(user_id, UTC date, ip)` into `pageview_daily_visitors`, ignoring
   conflicts on its unique constraint.
2. Insert the raw pageview with the captured timestamp.
3. Increment daily views; increment daily unique visitors only if step 1
   inserted a row.
4. Commit all three changes.

Concurrent first visits serialize through the unique constraint. Any error
rolls back the entire event. A visitor is still an IP, not a person; shared IPs
merge visitors and changing IPs split them. Multi-day unique totals remain the
existing sum of daily visitors, not distinct people over the whole period.

The visitor table uses a UUIDv7 primary key and a date/id retention index.
Migration seeds today's visitor keys from existing rows to avoid recounting
existing IPs on cutover. It does not rewrite historical totals. Old proxy
processes can serve during this additive migration; the improved counting
semantics begin when the new proxy takes traffic. Legacy writes between the
seed and traffic switch can still recount a visitor at cutover; this transition
does not rewrite existing totals or require downtime.

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

## Deployment and validation

Deploy the additive migration before the new proxy; ordinary blue-green deploy
is sufficient, without `DEPLOY_DOWNTIME=1`. Schedule configuration automatically
registers cleanup through the maintenance catalog. Regenerate db.d.ts from a
fully migrated disposable database. Validate request classification, queue
saturation, concurrent same-IP writes, atomic rollback, UTC date handling, and
retention preserving recent rows/daily totals against disposable PostgreSQL.

Rollback to the old proxy remains possible, but its legacy counting returns.
Retained aggregates are not undone; already expired raw events are not
recoverable by a migration rollback.
