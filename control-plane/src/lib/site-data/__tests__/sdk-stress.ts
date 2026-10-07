import { performance } from "node:perf_hooks";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { sql } from "kysely";
import { db, pool } from "@/lib/database";
import type { NaruClient, Admin } from "../../../../public/sdk/1.0.0/naru.js";

// Opt-in diagnostic workload, run only against the disposable integration DB.
export async function runSdkStress({
  naru,
  admin,
  origin,
  nativeFetch,
}: {
  naru: NaruClient;
  admin: Admin;
  origin: string;
  nativeFetch: typeof fetch;
}) {
  const samples = Number(process.env.NARU_STRESS_SAMPLES ?? 500);
  const cardinalities = (process.env.NARU_STRESS_ROWS ?? "1000,9000")
    .split(",")
    .map(Number);
  const concurrencies = (process.env.NARU_STRESS_CONCURRENCY ?? "1,8,32")
    .split(",")
    .map(Number);
  if (
    ![samples, ...cardinalities, ...concurrencies].every(
      (n) => Number.isSafeInteger(n) && n > 0,
    ) ||
    cardinalities.some((n) => n < 300 || n > 9900) ||
    concurrencies.some((n) => n > 100)
  )
    throw new Error(
      "Use positive integer settings, 300–9900 rows, and concurrency at most 100.",
    );
  const results: unknown[] = [];
  const plans: unknown[] = [];
  const feed = naru.collection<{
    rank: number;
    visible: boolean;
    payload: string;
  }>("feed");
  const writes = admin.collection("feed");
  const collection = await db
    .selectFrom("site_data_collections")
    .select("id")
    .where("name", "=", "feed")
    .executeTakeFirstOrThrow();
  for (const rows of cardinalities) {
    await db.deleteFrom("site_data_documents").execute();
    await sql`insert into site_data_documents(collection_id, id, data, size_bytes)
      select ${collection.id}::integer, 'post_' || n,
        jsonb_build_object('rank', n, 'visible', n % 2 = 0, 'payload', repeat('x', 256)), 300
      from generate_series(1, ${rows}::integer) n`.execute(db);
    await sql`analyze site_data_documents`.execute(db);
    const page = await feed.list({ size: 100 });
    if (page.documents.length !== 100 || (await feed.count()) !== rows)
      throw new Error("Invalid fixture");
    for (const concurrency of concurrencies) {
      // Restore read distribution after the preceding write sweep.
      await sql`update site_data_documents set data=jsonb_build_object('rank', substring(id from 6)::integer, 'visible', substring(id from 6)::integer % 2 = 0, 'payload', repeat('x', 256)) where collection_id=${collection.id}`.execute(
        db,
      );
      const workloads: [string, (i: number) => Promise<unknown>, number][] = [
        [
          "raw HTTP get",
          async () => {
            const r = await nativeFetch(
              `${origin}/api/data/v1/alice/feed/post_1`,
              { headers: { Origin: origin } },
            );
            if (!r.ok) throw new Error(String(r.status));
            return r.json();
          },
          1,
        ],
        ["get", () => feed.get("post_1"), 1],
        ["admin get", () => writes.get("post_1"), 1],
        ["list default", () => feed.list({ size: 50 }), 1],
        [
          "list equality",
          () => feed.list({ filter: { visible: true }, size: 50 }),
          1,
        ],
        [
          "list range + sort",
          () =>
            feed.list({
              filter: { rank: { gte: Math.floor(rows / 2) } },
              sort: [["rank", "desc"]],
              size: 50,
            }),
          1,
        ],
        ["count", () => feed.count(), 1],
        [
          "list includeTotal",
          () => feed.list({ size: 50, includeTotal: true }),
          1,
        ],
        [
          "pages 300 documents",
          async () => {
            let n = 0;
            for await (const p of feed.pages({ size: 100 })) {
              n += p.documents.length;
              if (n >= 300) break;
            }
            if (n !== 300) throw new Error("Incomplete pages");
          },
          1,
        ],
        [
          "set distinct ids",
          (i) =>
            writes.set(`post_${(i % rows) + 1}`, {
              rank: (i % rows) + 1,
              visible: true,
              payload: "x".repeat(256),
            }),
          1,
        ],
        [
          "set same id",
          () =>
            writes.set("post_1", {
              rank: 1,
              visible: true,
              payload: "x".repeat(256),
            }),
          1,
        ],
        [
          "batch 10 sets",
          (i) =>
            admin.batch(
              Array.from({ length: 10 }, (_, j) => ({
                collection: "feed",
                set: {
                  id: `post_${((i * 10 + j) % rows) + 1}`,
                  data: {
                    rank: ((i * 10 + j) % rows) + 1,
                    visible: true,
                    payload: "x".repeat(256),
                  },
                },
              })),
            ),
          10,
        ],
        [
          "batch 100 sets",
          (i) =>
            admin.batch(
              Array.from({ length: 100 }, (_, j) => ({
                collection: "feed",
                set: {
                  id: `post_${((i * 100 + j) % rows) + 1}`,
                  data: {
                    rank: ((i * 100 + j) % rows) + 1,
                    visible: true,
                    payload: "x".repeat(256),
                  },
                },
              })),
            ),
          100,
        ],
        [
          "add + delete",
          async () => {
            const d = await writes.add({ payload: "x".repeat(256) });
            await writes.delete(d.id);
          },
          2,
        ],
      ];
      for (const [method, operation, units] of workloads) {
        for (let i = 0; i < 3; i++) await operation(i);
        const latency: number[] = [];
        const errors: Record<string, number> = {};
        let next = 0;
        let maxWaiting = 0;
        let maxUsed = 0;
        const timer = setInterval(() => {
          maxWaiting = Math.max(maxWaiting, pool.waitingCount);
          maxUsed = Math.max(maxUsed, pool.totalCount - pool.idleCount);
        }, 5);
        const cpu = process.cpuUsage();
        const started = performance.now();
        try {
          await Promise.all(
            Array.from({ length: concurrency }, async () => {
              while (next < samples) {
                const i = next++;
                const start = performance.now();
                try {
                  await operation(i);
                  latency.push(performance.now() - start);
                } catch (e) {
                  const key = (e as { code?: string }).code ?? String(e);
                  errors[key] = (errors[key] ?? 0) + 1;
                }
              }
            }),
          );
        } finally {
          clearInterval(timer);
        }
        const elapsed = performance.now() - started;
        const used = process.cpuUsage(cpu);
        latency.sort((a, b) => a - b);
        const percentile = (p: number) =>
          +(
            latency[Math.max(0, Math.ceil(latency.length * p) - 1)] ?? 0
          ).toFixed(2);
        const result = {
          rows,
          concurrency,
          method,
          completed: latency.length,
          errors,
          requestsPerSecond: +((latency.length / elapsed) * 1000).toFixed(1),
          unitsPerSecond: +(
            ((latency.length * units) / elapsed) *
            1000
          ).toFixed(1),
          p50Ms: percentile(0.5),
          p95Ms: percentile(0.95),
          p99Ms: percentile(0.99),
          maxWaiting,
          maxUsed,
          nodeCpuMs: (used.user + used.system) / 1000,
        };
        results.push(result);
        console.log(JSON.stringify(result));
      }
    }
    plans.push({
      rows,
      quota: (
        await sql`explain (analyze, buffers, format json) select site_data_document_count, site_data_bytes_used from users where login_name='alice'`.execute(
          db,
        )
      ).rows,
      quotaScanBaseline: (
        await sql`explain (analyze, buffers, format json) select coalesce(sum(d.size_bytes),0), count(*) from site_data_documents d join site_data_collections c on c.id=d.collection_id where c.user_id=(select id from users where login_name='alice')`.execute(
          db,
        )
      ).rows,
      rangeSort: (
        await sql`explain (analyze, buffers, format json) select * from site_data_documents where collection_id=${collection.id}::integer and jsonb_typeof(data->'rank')='number' and data->'rank' >= ${JSON.stringify(Math.floor(rows / 2))}::jsonb order by ROW(CASE jsonb_typeof(coalesce(data->'rank', 'null'::jsonb)) WHEN 'string' THEN 1 WHEN 'number' THEN 2 WHEN 'boolean' THEN 3 ELSE 0 END, (CASE WHEN jsonb_typeof(coalesce(data->'rank', 'null'::jsonb))='string' THEN coalesce(data->'rank', 'null'::jsonb)#>>'{}' ELSE '' END) COLLATE "C", CASE WHEN jsonb_typeof(coalesce(data->'rank', 'null'::jsonb))='number' THEN coalesce(data->'rank', 'null'::jsonb)::numeric ELSE 0 END, CASE WHEN jsonb_typeof(coalesce(data->'rank', 'null'::jsonb))='boolean' THEN coalesce(data->'rank', 'null'::jsonb)::boolean ELSE false END) desc, id collate "C" desc limit 51`.execute(
          db,
        )
      ).rows,
    });
  }
  const dir = resolve(process.env.NARU_STRESS_OUTPUT ?? "stress-results");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    resolve(dir, "sdk-stress.json"),
    JSON.stringify(
      {
        recordedAt: new Date().toISOString(),
        implementation:
          "transactional usage counters + grouped batches + bounded write admission",
        node: process.version,
        samples,
        cardinalities,
        concurrencies,
        poolMax: pool.options.max,
        boundary:
          "Built SDK, loopback HTTP, actual routes, disposable PostgreSQL; media storage mocked; no Next listener/CDN",
        results,
        plans,
      },
      null,
      2,
    ) + "\n",
  );
  if (results.some((r) => Object.keys((r as { errors: object }).errors).length))
    throw new Error("Stress workload had errors; inspect sdk-stress.json");
}
