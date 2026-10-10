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
that, and they are counted when the control plane is back. The job fails while
the oldest waiting pageview is more than 30 minutes old, and also on any run
whose call to the log fails (a timeout, a Cloudflare 503). The ordinary
job-failure alert reports only failures that last 30 minutes without a
successful run, so a single failed call, which the next run makes up, is
silent.

## Daily rollups and distinct visitors

The event captures its UTC request time when the Worker receives the request,
so a midnight crossing or a delay in the log does not move it to another day.
No pageview is stored on its own. One transaction per batch, with a 30-second
statement timeout, adds the batch to four daily rollups, each keyed by site
and UTC date:

| Table                      | Per                            | Holds                   |
| -------------------------- | ------------------------------ | ----------------------- |
| `pageview_daily_stats`     | site                           | views, visitors, sketch |
| `pageview_daily_paths`     | path                           | views, sketch           |
| `pageview_daily_referrers` | referrer (`''`: none)          | views                   |
| `pageview_daily_browsers`  | browser named by `browsers.ts` | views                   |

and then records the batch's last id and commits. Any error rolls back the
entire batch, which the next run takes again.

Distinct visitors are HyperLogLog sketches from the postgresql-hll extension:
a visitor is `hll_hash_text(host(ip))`, and sketches use `log2m` 14 (sketches
union only with sketches of the same parameters). A sketch is an exact set of
hashes up to about 1,280 visitors, which almost every site-day and path-day
stays under, and within about 0.8% past that. Addresses are never stored. A
visitor is still an IP, not a person; shared IPs merge visitors and changing
IPs split them.

A day's unique visitor count is its sketch's cardinality, stored as an integer
when the day is updated. Seven- and thirty-day figures, and a path's thirty-day
visitors, are the cardinality of the union of the days' sketches, so a visitor
returning on several days counts once. Days without a sketch (expired, or
counted before sketches) add their stored count instead. All-time totals
remain the sum of daily counts.

The migration that introduced the rollups (`1791610422484`) built them from
the 35 days of raw pageviews and visitor addresses then kept, which it
dropped. Daily totals kept the counts they had.

## Retention and query compatibility

A durable maintenance job runs every 15 minutes, removing path, referrer and
browser rollups before UTC midnight 35 days ago and clearing site-day sketches
as old. Each transaction changes at most 1,000 rows with `SKIP LOCKED`; each
run changes at most 100,000 rows per table. Daily totals remain indefinitely,
preserving `지금까지의 조회` at its accumulated value; lifetime counts and
historical daily graphs survive cleanup.

## Validation

Regenerate db.d.ts from a fully migrated disposable database. Validate request
classification, duplicate batches after a lost acknowledgement, sketches
merging across batches and days, UTC date handling, and retention preserving
recent rollups and daily totals against disposable PostgreSQL with
postgresql-hll installed.
