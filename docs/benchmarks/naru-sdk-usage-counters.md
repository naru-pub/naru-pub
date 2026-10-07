# Transactional quota counters: implementation and measurements

The SDK write path now reads site usage counters from the owner row instead of
aggregating every document. Quotas remain enforced within the write transaction.
The site's existing owner lock still serializes writes and collection changes.

## Implementation

`1791377967407_site_data_usage_counters.ts` adds bigint document-count and
byte-usage columns to `users`, with a nonnegative constraint. It backfills
existing data and installs triggers in the migration transaction. The database
maintains counters for document insert/update/delete, including raw SQL writes.
Statement transition tables aggregate bulk-write deltas per owner. Updates with
zero net count/byte change skip the counter write. A collection-delete trigger
subtracts its usage before the parent disappears during FK cascade.

Single-document writes use counters returned by the existing locked owner
lookup. Batch writes check the final counters once, so repeated IDs and deletes
preserve the previous final-net-usage behavior. Conflicts and quota errors roll
back both documents and counters. Counters are marked as raw-SQL-only columns
in the codegen overrides; `db.d.ts` was regenerated against the complete
migrated schema.

The migration is compatible with older application instances: their writes
also update counters through the triggers while their quota checks can continue
using scans. No deployment downtime flag is required for compatibility. The
backfill and DDL take database locks during migration; assess backfill duration
on the production dataset before deployment. This change has only been applied
to disposable local databases.

## Comparison

Same local workload as [the baseline](naru-sdk-local.md): 500 operations per
case, 1,000/9,000 documents, concurrency 1/8/32, pool size 20, closed-loop
workers, real built SDK and HTTP routes, disposable PostgreSQL. Both snapshots
are saved, with the updated run in
[naru-sdk-usage-counters.json](naru-sdk-usage-counters.json). The updated sweep
completed all 42,000 measured operations with zero errors in about 73 seconds
versus 88 seconds in the baseline. These runs are sequential local measurements,
not a randomized experiment or a production capacity estimate.

Selected results at 9,000 documents:

| Workload         | Workers | Before ops/sec | After ops/sec | Throughput ratio | Before p95 ms | After p95 ms |
| ---------------- | ------: | -------------: | ------------: | ---------------: | ------------: | -----------: |
| set distinct ids |       1 |            601 |        1353.3 |            2.25× |          1.79 |         0.79 |
| set distinct ids |      32 |          504.8 |        1599.7 |            3.17× |         64.94 |        22.99 |
| set same id      |       1 |          602.7 |        1359.7 |            2.26× |          1.78 |         0.81 |
| set same id      |      32 |            470 |          1689 |            3.59× |         85.01 |        19.88 |
| batch 10 sets    |       1 |            423 |           580 |            1.37× |           2.6 |         1.93 |
| batch 10 sets    |      32 |          374.2 |         682.7 |            1.82× |         97.88 |        47.71 |
| batch 100 sets   |       1 |           95.2 |          95.5 |            1.00× |          12.7 |        11.34 |
| batch 100 sets   |      32 |           85.6 |         100.7 |            1.18× |        491.56 |       346.07 |
| add + delete     |       1 |          406.2 |         754.3 |            1.86× |          2.85 |         1.43 |
| add + delete     |      32 |          365.5 |        1082.8 |            2.96× |        181.52 |        33.62 |
| get              |       1 |         1955.9 |        2683.6 |            1.37× |          0.97 |         0.41 |
| get              |      32 |         5528.4 |        5538.1 |            1.00× |          7.31 |         6.84 |

Batch ops/sec counts complete batches; multiply by batch size for document
writes/sec. Add/delete is a two-call workload. Raw HTTP reads stayed within
about 5% of baseline throughput across worker counts, supporting a write-path
improvement rather than a general change in host speed. Small differences in
read and large-batch cases should still be treated cautiously.

The updated snapshot includes the constant-size usage lookup and the old scan
as a query-plan control. At 9,000 rows, representative execution times were
0.004 ms for the lookup and 3.129 ms for the old aggregation on the same updated
dataset. These are warm, tiny local timings; the structural improvement is
removing document-count-dependent work, not the precise timing ratio.

## Remaining limits at this stage

Large batches still issue SQL per operation while holding the site lock; their
improvement is smaller than single sets. Grouping compatible batch writes is
the next write optimization. Field range/sort reads still scan and sort; their
representative plan remained around 5.4 ms at 9,000 rows. Declared indexed fields
or controlled expression indexes remain a separate improvement. The pool still
queues requests above 20 active connections. Removing quota scans does not
remove those constraints.

## Verification

- All 131 site-data tests passed, including existing concurrent quota checks.
- Six new counter tests cover backfill/down migration, size changes, raw bulk
  writes, collection/user cascades, repeated-ID batches, conflict rollback,
  byte-quota rollback and cross-owner document moves.
- The strengthened migration test was rerun after adding preexisting content
  before rollback; all six counter tests passed.
- TypeScript and ESLint on the changed source files passed.
- Generated database types matched the fully migrated schema.
- All 274 payment/database regression tests passed, including generated-type
  verification against the complete migrated schema.
- Prettier and `git diff --check` passed.

The subsequent [grouped-batch optimization](naru-sdk-grouped-batches.md) addresses
the sequential SQL cost for distinct unconditional operations.
