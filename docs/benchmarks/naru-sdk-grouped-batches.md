# Grouped SDK batches

> Historical benchmark of the former PostgreSQL document backend. Its storage and write-admission details do not describe the current Durable Object implementation.


`executeBatch()` now groups unconditional operations on distinct document keys
into at most one delete statement and one multi-row upsert. That removes the
per-operation SQL round trips and lets the usage triggers aggregate each
statement's changes once per owner.

The existing site lock, authorization checks, document size limits, final quota
check and transaction remain in place. Returned metadata is mapped by collection
and document ID, then restored to the caller's operation order; PostgreSQL
`RETURNING` order is not assumed. Upserts advance each existing document's
revision once and retain its creation timestamp.

A batch with any condition or repeated collection/document key uses the
sequential path. That preserves conditions that depend on earlier operations,
repeated-key revisions, and delete/recreate behavior. The same ID in different
collections is eligible for grouping. Mixed grouped batches delete first, then
upsert distinct keys, and enforce the final net usage; a failure rolls all
changes back. Invalid operations are still rejected. The SDK API is unchanged.
This stage requires no additional migration beyond the earlier usage counters.

## Local results

The same 42,000-operation sweep completed with zero errors in about 49 seconds,
versus 73 seconds for the [quota-counter version](naru-sdk-usage-counters.md)
and 88 seconds for the original baseline. The client, loopback HTTP adapter,
routes and disposable PostgreSQL run locally; CDN, browser media processing,
network latency and production hardware are excluded. Measurements are
sequential runs on the same host, not randomized trials or production SLOs.

Results at 9,000 documents, compared with the quota-counter version:

| Batch size | Workers | Before batches/sec | After batches/sec | Ratio | Before p95 ms | After p95 ms | After document writes/sec |
| ---------: | ------: | -----------------: | ----------------: | ----: | ------------: | -----------: | ------------------------: |
|         10 |       1 |                580 |            1061.7 | 1.83× |          1.93 |         1.02 |                   10617.1 |
|         10 |       8 |              712.3 |            1231.9 | 1.73× |         11.79 |         7.11 |                   12318.7 |
|         10 |      32 |              682.7 |            1183.1 | 1.73× |         47.71 |         28.6 |                   11830.8 |
|        100 |       1 |               95.5 |               328 | 3.43× |         11.34 |         3.48 |                   32796.4 |
|        100 |       8 |              100.8 |             321.3 | 3.19× |         87.43 |        26.91 |                   32129.3 |
|        100 |      32 |              100.7 |             311.6 | 3.09× |        346.07 |       124.02 |                   31157.5 |

Small point reads, raw HTTP reads, and distinct-ID single sets stayed within
about 4% of their previous throughput at these dataset/concurrency settings.
The measured improvement is concentrated in batches. At concurrency 32,
batches of 100 now produce about 31,158 document writes/sec, versus 8,560 in
the original pre-counter baseline (about 3.6× across both improvements).

Raw results and query plans are saved in
[naru-sdk-grouped-batches.json](naru-sdk-grouped-batches.json).

## Verification and remaining work

The site-data suite includes tests for ordered results across collections,
revision increments, repeated conditional operations, grouped missing deletes,
mixed sets/deletes at the byte limit, and complete rollback of deletes and
inserts when final usage exceeds quota. Existing SDK HTTP integration tests
also exercise the grouped path. The full site-data suite, TypeScript, ESLint,
formatting, and whitespace checks passed.

Field range/sort reads still scan and sort the dataset, and writes still
serialize per site. A batch containing one dependent operation currently keeps
all operations sequential; grouping safe contiguous segments could improve
that case later. The next larger read improvement is an indexing strategy for
supported fields and sort/cursor semantics. No production deployment was made.

Reproduce with `cd control-plane && pnpm stress:sdk`.
