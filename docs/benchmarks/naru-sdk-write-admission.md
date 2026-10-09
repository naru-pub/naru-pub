# Write admission before database checkout

> Historical benchmark of the former PostgreSQL document backend. Its storage and write-admission details do not describe the current Durable Object implementation.


Document and collection writes now enter bounded process-local admission before
service SQL, including anonymous-write rate-limit preflight. Reads bypass
admission. Cookie authentication for control-plane HTTP requests can run before
service admission.
At most one request per site is admitted at a time; a global budget admits at
most `max(1, floor(pool_max / 2))` site-data writers per process. PostgreSQL's
owner-row lock still protects quota accounting, conditions and collection
changes across processes.

## Limits and request lifecycle

- 64 queued writes per site and 256 queued writes per process.
- Ten-second maximum wait for admission. An overflow or expired wait returns
  HTTP 503 with the existing `UNAVAILABLE` protocol code, before executing SQL.
- Queued requests occupy no database connection. FIFO ordering is maintained
  within a site. Scheduling skips requests whose site is active, so another
  eligible site can use a free global slot.
- The HTTP route forwards `request.signal`. An aborted queued request is
  removed immediately. Timers and abort listeners are cleaned on admission,
  rejection or cancellation. The signal is checked again before execution.
- An already executing operation settles before its admission slot is released,
  even if its client disconnects. Every success and failure releases the slot.
  This is not transaction cancellation or a durable job queue.

Limits are local to each process, not distributed across web instances or job
workers. Media writes and other database request paths are not admitted by
this gate. With pool size one, the minimum one-writer budget leaves no separate
read capacity. More generally, the gate bounds document writes rather than
reserving physical connections against every other workload. This change has
no migration and has not been deployed.

## Mixed-workload comparison

The same pool-20 mixed workload as
[the baseline](naru-sdk-mixed-workloads.md) ran for three seconds per case with
four point readers on each of two sites. Background traffic was on the first
site only. Payloads were 256 bytes or 16 KiB; 100-operation write batches used
256-byte payloads to fit the API request-size limit. The run completed 143,242
workload operations with zero errors in about 44 seconds including setup and
in-flight request drain.

Selected results with 256-byte foreground payloads:

| Background writers         | Other-site read p95 before ms | After ms | Other-site reads/sec before |  After | DB pool queue before | After | Admission queue after |
| -------------------------- | ----------------------------: | -------: | --------------------------: | -----: | -------------------: | ----: | --------------------: |
| read baseline              |                           2.4 |      2.5 |                      2446.3 | 2373.1 |                    0 |     0 |                     0 |
| 8 grouped batch writers    |                          3.41 |      3.7 |                      1742.4 | 1510.2 |                    0 |     0 |                     7 |
| 32 grouped batch writers   |                         47.28 |     3.99 |                        94.3 | 1495.9 |                   20 |     0 |                    31 |
| 32 dependent batch writers |                        552.43 |     3.02 |                         9.8 | 1939.6 |                   20 |     0 |                    31 |

With 32 dependent writers, unrelated read p95 fell from 552 to 3 ms, while
read throughput rose from about 10 to 1,940/sec. The pool peaked at 9 occupied
connections rather than 20; up to 31 writes waited outside the pool. Grouped
write bursts also stopped starving reads: their unrelated read p95 fell from
47 to 4 ms. No database-checkout queue was sampled in any updated mixed case.
The 16 KiB variant showed the same effect: other-site read p95 fell from 548
to 2.91 ms during the dependent-write burst.

This is a fairness improvement, not a promise of higher throughput for every
traffic group. In the small-payload grouped 32-writer case, background batch
throughput fell from 300 to 179 batches/sec while read throughput recovered.
Dependent batch throughput was 35.2 versus 27.5/sec. Those group rates include
their drain times and share client/server CPU, so treat precise ratios
cautiously. Large-page-only control cases varied more than point-read controls;
this gate does not optimize large responses or filtered sorting.

## Isolated method checks

The original 42,000-operation method sweep also passed with zero errors.
Selected results at 9,000 documents, compared with the grouped-batch snapshot:

| Method           | Workers | Before ops/sec | After ops/sec | Before p95 ms | After p95 ms |
| ---------------- | ------: | -------------: | ------------: | ------------: | -----------: |
| get              |      32 |         5339.2 |        5544.3 |          7.42 |          6.9 |
| set distinct ids |       1 |         1345.1 |        1411.2 |          0.83 |         0.77 |
| set distinct ids |       8 |         1726.2 |        1487.1 |          5.19 |          6.1 |
| set distinct ids |      32 |         1582.7 |        1523.8 |         23.63 |        21.84 |
| batch 100 sets   |      32 |          311.6 |         316.7 |        124.02 |       124.83 |
| add + delete     |      32 |         1045.1 |         895.2 |         34.61 |        38.13 |

Single-worker writes and batches of 100 stayed close to their previous rates.
Small writes lost some concurrency benefit: eight-worker sets were about 14%
slower, and the 32-worker add/delete workload was about 14% slower. This is the
cost of admitting one complete write request per site rather than allowing
multiple transactions to pipeline before waiting for the owner lock. The gate
prioritizes predictable read service under bursts. A bounded two-writer
pipeline could be evaluated later, while keeping the global connection budget.

## Validation and limits

All 148 site-data tests passed, including ten admission tests and three HTTP
checks for signal forwarding, uncached overload responses and expected
cancellation. Admission tests cover per-site serialization, global capacity,
FIFO scheduling, both queue bounds, wait expiry even before an overdue timer
callback runs, abort-before-execution,
queued cancellation, active-operation completion, and slot release after
synchronous/asynchronous failures. Existing quota/revision/cascade tests passed.
TypeScript, ESLint on changed source, Prettier and whitespace checks passed.

These are sequential local closed-loop runs, with client and server in one
Node process, real SDK/HTTP routes and disposable PostgreSQL. There is no CDN,
browser or production network. Worst-case baseline read groups contain only
few dozen samples, so their p95s demonstrate starvation rather than estimate
production SLOs. Connection/admission states are sampled every 5 ms. Repeat
longer, separate-process tests before setting production performance targets.
The global admission budget was unit-tested; this two-site workload writes to
only one site, so it does not measure many simultaneous writing tenants.

Raw results:

- [Mixed workload after admission](naru-sdk-write-admission.json)
- [Isolated methods after admission](naru-sdk-write-admission-methods.json)

Reproduce from `control-plane` with `pnpm stress:sdk:mixed` and `pnpm stress:sdk`.
