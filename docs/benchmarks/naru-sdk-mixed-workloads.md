# Mixed-site SDK workloads and public cache audit

> Historical benchmark of the former PostgreSQL document backend. Its storage and write-admission details do not describe the current Durable Object implementation.


The next performance priority is to control write admission before requests
occupy database connections. Valid write bursts on one site can starve reads
on a different site through the shared pool. The existing per-site PostgreSQL
owner lock is necessary for correctness, but allowing many requests to check
out connections while waiting for that lock makes its cost spill across sites.

## Reproduction

From `control-plane`:

```sh
pnpm stress:sdk:mixed
DATABASE_POOL_MAX=40 NARU_STRESS_OUTPUT=/tmp/naru-mixed-pool40 pnpm stress:sdk:mixed
```

The runner creates and removes a disposable PostgreSQL cluster and redirects
SDK HTTP exclusively to loopback. `NARU_MIXED_DURATION_MS` controls each case's
load-generation window (default 3000 ms; range 1000–30000). Output is
`stress-results/sdk-mixed-stress.json`, or the directory selected by
`NARU_STRESS_OUTPUT`. The normal integration suite skips this opt-in workload.
Any operation errors fail the run after results are saved.

Each site has 500 documents. Four workers continuously read an untouched
single document on the busy site, and four read a second site's document.
The second site's payload remains 256 bytes; the busy site is tested with
256-byte and 16,384-byte payloads. Fixtures reset between cases. Background
traffic runs on the busy site:

- No background traffic: the read baseline.
- 1, 8 or 32 workers writing grouped batches of 100 distinct keys.
- 1 or 32 workers writing dependent batches of 100 updates to one key, using
  the sequential fallback. This is a valid worst-case workload, not a claim
  that typical users write this way.
- 8 workers listing 50-document pages.

Writer payloads are fixed at 256 bytes to fit the existing 64 KiB total
request-body limit. A batch can contain up to 100 operations, but cannot
contain 100 large documents. Point reads target `post_499`, which writers do
not alter; their configured payload size stays constant.

Measured on local macOS arm64 with the deployed grouped-batch code, PostgreSQL
18.6 and the Node version recorded in the snapshots. The final pool-20 run
completed 115,106 workload operations; pool-40 completed 159,631. Both had zero
errors. These counts include both reader groups and complete background
batches/pages, not individual batch document writes. Each sweep took about
46 seconds including setup and draining in-flight requests.

## Connection-pool starvation

Selected results with 256-byte point reads. The reported read is on the
**other site**, which does not share the writer's owner lock:

| Background traffic         | Pool 20: other-site read p95 ms | Pool 40: other-site read p95 ms | Pool 20: batch/sec | Pool 40: batch/sec |
| -------------------------- | ------------------------------: | ------------------------------: | -----------------: | -----------------: |
| Read baseline              |                            2.40 |                            2.34 |                  — |                  — |
| 1 grouped batch writer     |                            3.10 |                            3.68 |              174.0 |              161.1 |
| 8 grouped batch writers    |                            3.41 |                            4.61 |              189.5 |              162.9 |
| 32 grouped batch writers   |                           47.28 |                            3.55 |              300.1 |              144.1 |
| 1 dependent batch writer   |                            2.45 |                            2.41 |               31.2 |               32.2 |
| 32 dependent batch writers |                          552.43 |                            2.46 |               27.5 |               20.1 |

With 32 writers and 8 readers, the default pool reached 20 occupied
connections and 20 pending checkouts. Pool 40 had no sampled checkout queue
in these cases because the test has at most 40 simultaneous requests.
Increasing the pool protected reads here, but did not increase dependent
write throughput: those writes still serialize. Dependent batch p95 increased
from 1,357 ms with pool 20 to 2,002 ms with pool 40. A single dependent writer
had batch p95 around 36 ms while sustaining similar or better throughput and
keeping unrelated reads fast.

The high grouped-write throughput with pool 20 also comes at the expense of
read throughput: unrelated readers fell from about 2,446 to 94 reads/sec.
With pool 40 they reached about 1,861 reads/sec while grouped writes shared
more CPU and database work with those reads. Comparing write throughput alone
would miss that tradeoff.

The 16 KiB point-read variant showed the same pool-starvation pattern; the
small read on the other site reached p95 548 ms with 32 dependent writers and
pool 20. This is not caused by the read taking the writer's owner lock.
The pool queues, known owner-lock scope and concurrency comparison support
this diagnosis; this test does not include a PostgreSQL lock-wait trace.

### Recommended implementation

Add bounded per-site write admission **before** database checkout, plus a
global write budget so multiple busy sites cannot collectively occupy the
whole pool. Reserve capacity by limiting admitted writes rather than simply
raising total database connections. Bound queued requests, account for request
cancellation/deadlines, and release admission slots on every failure path.
Keep the PostgreSQL owner lock for correctness across processes. A per-process
gate improves local pool fairness; cross-instance limits and background jobs
need separate consideration before claiming global fairness.

The one-writer cases are evidence for admission control, not an implementation
of it: client-side concurrency was limited for those cases. Production process
behavior has not changed in this work.

## Large responses

With pool 20 and 8 background page readers:

| Busy-site payload per document | Background pages/sec | Page p95 ms | Other-site point-read p95 ms |
| ------------------------------ | -------------------: | ----------: | ---------------------------: |
| 256 bytes                      |              1,166.4 |        7.72 |                         6.67 |
| 16,384 bytes                   |                211.5 |       43.12 |                         7.60 |

Each large page carries about 800 KiB of payload before metadata. No pool
queue was sampled in either page-reader case. Aggregate Node CPU time rose
from about 3,311 to 4,568 ms over roughly three seconds. That includes both
SDK client and HTTP server work; it does not isolate serialization, parsing,
response copies, PostgreSQL TOAST work or driver costs. The synthetic payload
is repeated text and can compress well in PostgreSQL; the loopback adapter
does not model production HTTP compression.

Next steps for this avenue: profile separate client and server processes,
measure returned bytes, and test field projection or smaller pages for list
views that need only titles/previews. Do not attribute the whole slowdown to
an SDK JSON parser based on this shared-process test.

## Public cache behavior

The local probes record transport flags and response headers, retaining no
document values or credentials:

| Probe                                           | SDK fetch cache | `fresh=1` | Origin cache policy            |
| ----------------------------------------------- | --------------- | --------- | ------------------------------ |
| Anonymous before a local write                  | default         | No        | public, max-age=0, s-maxage=10 |
| Owner write                                     | no-store        | No        | no-store                       |
| Anonymous same-collection read after that write | no-store        | Yes       | no-store                       |
| Other-site read after that write                | default         | No        | public, max-age=0, s-maxage=10 |
| Owner read                                      | no-store        | Yes       | no-store                       |

The post-write bypass lasts for the loaded SDK module's lifetime and is scoped
to touched paths; it does not disable cache eligibility on another site.
Authenticated responses are never publicly cacheable. These observations
match the existing integration contract and source code.

There is no CDN/shared cache in this harness, so there is **no measured cache
hit rate**. Public cacheable headers alone do not prove Cloudflare stores a
response. The required zone rule and verification instructions are documented
in [deployment.md](../deployment.md#cloudflare-cache-rule-for-public-data-reads).
The production rule and real hit/miss distribution were not inspected or
changed. The next cache investigation should use edge analytics and repeated
public GETs, checking that authenticated and `fresh=1` requests remain uncached.
Extending the cache TTL also extends the exposure window after a collection
changes from public to private; avoid tuning it as a pure throughput setting.

## Limits and validation

These are closed-loop clients in a shared Node process, with real routes and a
synthetic disposable schema, no browser, Next listener, CDN cache or production
network. Workers stop issuing requests at the window deadline, then drain
in-flight requests. Throughput denominators include each group's drain time.
The worst starvation cases have only a few dozen foreground samples, so p95
values diagnose the problem and are not SLO estimates. Pool metrics are sampled
every 5 ms; event-loop delay has 10 ms resolution. Fixed scenario order and
sequential pool comparisons allow warm-cache and host effects; repeat longer
runs before choosing production settings.

Both mixed sweeps passed with zero errors. The normal site-data suite passed
all 135 tests, with the two stress workloads skipped. TypeScript, ESLint on the
changed test files, Prettier and `git diff --check` passed. Only the opt-in
benchmark, package script and reports changed; nothing was committed or
deployed during this investigation.

Raw snapshots:

- [Pool 20](naru-sdk-mixed-pool20.json)
- [Pool 40](naru-sdk-mixed-pool40.json)

The subsequent [write-admission implementation](naru-sdk-write-admission.md)
queues document writes before pool checkout and reports the before/after
comparison, including isolated write-throughput tradeoffs.
