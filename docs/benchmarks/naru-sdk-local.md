# Local Naru SDK stress test

> Historical benchmark of the former PostgreSQL document backend. Its storage and write-admission details do not describe the current Durable Object implementation.


Run from `control-plane`:

```sh
pnpm stress:sdk
```

Requires installed project dependencies and PostgreSQL binaries (`pg_config`,
`initdb`, `pg_ctl`, `createdb`). Override their directory with `NARU_TEST_PG_BIN`.
The existing integration runner creates and destroys a private PostgreSQL
cluster, overrides `DATABASE_URL`, and uses a private Unix socket. SDK traffic
is redirected exclusively to loopback HTTP. No production services are called.

```sh
NARU_STRESS_SAMPLES=1000 \
NARU_STRESS_ROWS=1000,9000 \
NARU_STRESS_CONCURRENCY=1,8,32 \
pnpm stress:sdk
```

Defaults: 500 measured operations per method and concurrency, three sequential
warm-up operations, 1,000 and 9,000 documents, concurrency 1/8/32, pool maximum 20. `DATABASE_POOL_MAX` can change the pool for comparison. Output goes to
`control-plane/stress-results/sdk-stress.json`; `NARU_STRESS_OUTPUT` overrides
that directory. Any measured operation error fails the run after saving results.
Each workload runs separately, with a fixed number of workers issuing another
operation only after the previous one finishes (closed-loop load).

The built SDK crosses native fetch, a real loopback HTTP socket, the actual
Next route handlers, service code, and PostgreSQL. The listener is an adapter,
so Next server overhead, browser scheduling, CDN/cache hits, network latency,
and production deployment hardware are excluded. The client and server share
one Node process. Files are mocked at the external storage boundary; this test
does not measure `media.upload()` or browser image processing, interactive
sign-in, cold starts, multi-site fairness, large document payloads, or long
soak behavior. The standard SDK contract suite separately verifies upload and
authorization correctness.

Payloads contain rank, visibility and 256 bytes of text. Fixture loading uses
SQL, not measured SDK calls. Each concurrency sweep restores rank and visibility.
Write cases update existing IDs to keep cardinality stable; add/delete is a
combined operation. Page traversal stops after three 100-document pages.
Request/sec means completed workload operations/sec: a traversal makes three
HTTP requests, and add/delete makes two. `unitsPerSecond` counts document writes
for batches and the two CRUD calls for add/delete. Pool figures are sampled
maximums every 5 ms, not continuous traces. Node CPU time includes the load
generator and route handling, and excludes PostgreSQL CPU. p99 is diagnostic,
not a production SLO estimate. Short cases and host contention introduce noise;
compare repeated runs before treating small differences as regressions.

## Findings

Measured on local macOS arm64, PostgreSQL 18.6, Node v26.7.0, on
2026-10-07 (Asia/Seoul). The final sweep completed 42,000 measured workload
operations across 84 cases, with zero errors, in about 88 seconds. Raw
measurements and representative `EXPLAIN (ANALYZE, BUFFERS)` plans are saved in
[naru-sdk-local.json](naru-sdk-local.json).

Selected results at 9,000 documents:

| Method              | Concurrency | Operations/sec | p95 ms | Document writes/sec |
| ------------------- | ----------: | -------------: | -----: | ------------------: |
| get                 |           1 |         1955.9 |   0.97 |                   — |
| get                 |          32 |         5528.4 |   7.31 |                   — |
| list default        |           1 |         1145.9 |   0.91 |                   — |
| list default        |          32 |         1300.1 |  38.41 |                   — |
| list equality       |           1 |          420.8 |   2.46 |                   — |
| list equality       |          32 |         1089.5 |  68.14 |                   — |
| list range + sort   |           1 |          117.5 |   9.05 |                   — |
| list range + sort   |          32 |          630.7 |  75.83 |                   — |
| count               |           1 |         1024.3 |   1.07 |                   — |
| count               |          32 |         2340.1 |  17.56 |                   — |
| pages 300 documents |           1 |            252 |   4.56 |                   — |
| pages 300 documents |          32 |          262.9 | 165.11 |                   — |
| set distinct ids    |           1 |            601 |   1.79 |                 601 |
| set distinct ids    |          32 |          504.8 |  64.94 |               504.8 |
| batch 10 sets       |           1 |            423 |    2.6 |              4229.7 |
| batch 10 sets       |          32 |          374.2 |  97.88 |              3741.7 |
| batch 100 sets      |           1 |           95.2 |   12.7 |              9519.1 |
| batch 100 sets      |          32 |           85.6 | 491.56 |              8560.3 |

1. **`set()` / `add()` and `batch()` share a per-site write ceiling.**
   `executeData()` and `executeBatch()` acquire `users FOR UPDATE` before
   doing work. Distinct document IDs do not avoid this owner lock. Increasing
   concurrency from 1 to 32 reduced distinct-ID set throughput from 601 to 505
   ops/sec while p95 rose from 1.79 to 64.94 ms. Same-ID writes showed similar
   behavior. These measurements and the lock scope strongly indicate per-site
   serialization; this run did not collect a PostgreSQL lock-wait trace.
   Every single set also aggregates byte usage and document count across the
   whole site; batch aggregates once at its end. The representative quota
   aggregation took 0.60 ms at 1,000 rows and 1.88 ms at 9,000 rows.

   Highest-priority optimization: maintain transactional site usage counters,
   applying the net byte/count delta while preserving conditional writes,
   quota correctness, rollback, and collection deletion semantics. This reduces
   work inside the lock. Do not simply remove the lock: it currently protects
   those invariants. Investigate finer locking only after quota accounting and
   collection lifecycle synchronization are redesigned.

2. **`list()` with a numeric range and field sort is the slowest single
   read request here.** At 9,000 rows it returned about 118 pages/sec at
   concurrency 1 versus 1,146 for default ID ordering. The representative
   range/sort plan scanned all 9,000 rows, selected 4,501, and sorted to return 51. Its execution time rose from 0.94 to 5.51 ms between dataset sizes.
   The shared JSONB GIN containment index does not supply this computed scalar
   order or numeric range. Equality on a low-selectivity boolean also performs
   worse than default ordering; equality-index benefits depend on selectivity.

   Next optimization: profile representative application filters and consider
   controlled expression indexes or supported indexed fields that match the
   API's scalar type ordering and cursor tie-breakers. Verify actual route SQL
   with query logging before implementing indexes; these saved plans reproduce
   the principal filter/order and quota expressions, not every response column.

3. **Large batches improve document throughput but create long requests.**
   At concurrency 1, batching 100 sets produced about 9,520 writes/sec versus
   601 single sets/sec. However, 32 concurrent batches reached p95 492 ms and
   only about 8,560 writes/sec. `executeBatch()` awaits each operation's SQL
   in sequence while holding the owner lock. Use bounded write concurrency and
   compare batch sizes for the application's latency budget. A potential server
   improvement is grouped SQL, with explicit handling of repeated IDs,
   per-operation revisions, conditions and rollback; a naive bulk upsert can
   change the existing contract.

4. **The pool becomes a second queue above 20 active requests.** At concurrency
   32 most list and write cases reached 20 occupied connections and 12 pending
   checkouts. Increasing the pool alone cannot remove the per-site lock or
   field-sort CPU cost, and can increase PostgreSQL contention. Tune concurrency
   and reduce transaction work before treating pool size as the primary fix.
   Mixed workloads and multiple sites should be the next stress scenarios to
   measure collateral effects on other control-plane requests.

5. **`pages()` pays for sequential requests and returned bytes.** Each measured
   traversal fetched 300 documents over three requests. Its p95 at concurrency
   32 was 165 ms; this is a traversal latency, not one request latency. Use
   the maximum useful page size, filters, and early termination. Parallel
   cursor requests cannot start until the preceding response supplies its token.
   `count()` also uses `list(size: 1, includeTotal: true)` in the SDK, so it
   incurs a page query as well as aggregation; a dedicated count route is a
   possible smaller optimization, though it was not the main limit here.

The raw-fetch baseline and SDK `get()` were similar at concurrency 8 (5,211 vs
5,378 ops/sec) and 32 (5,505 vs 5,528). There is no evidence here that the SDK
wrapper is the dominant cost for small point reads. Single-worker differences
and shared-process scheduling mean this is not a precise measurement of SDK
CPU overhead. A separate browser/client-process profile is needed for that.

Validation: the stress sweep passed with zero operation errors; all nine normal
SDK integration tests passed; TypeScript `tsc --noEmit`, ESLint on both touched
TypeScript files, Prettier, and `git diff --check` passed. This baseline snapshot predates the quota-counter optimization. See
[naru-sdk-usage-counters.md](naru-sdk-usage-counters.md) for the implementation
and before/after measurements.
