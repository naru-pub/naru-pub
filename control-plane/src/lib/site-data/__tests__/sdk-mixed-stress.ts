import { performance, monitorEventLoopDelay } from "node:perf_hooks";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { sql } from "kysely";
import { db, pool } from "@/lib/database";
import {
  createNaru,
  type Admin,
  type NaruClient,
} from "../../../../public/sdk/1.0.0/naru.js";
import { executeData } from "../service";
import { siteDataWriteAdmission } from "../write-admission";

type Summary = {
  label: string;
  workers: number;
  completed: number;
  errors: Record<string, number>;
  perSecond: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
};

export async function runSdkMixedStress({
  naru,
  admin,
}: {
  naru: NaruClient;
  admin: Admin;
}) {
  const durationMs = Number(process.env.NARU_MIXED_DURATION_MS ?? 3000);
  if (
    !Number.isSafeInteger(durationMs) ||
    durationMs < 1000 ||
    durationMs > 30000
  )
    throw new Error("Use NARU_MIXED_DURATION_MS between 1000 and 30000.");
  const alice = await db
    .selectFrom("users")
    .select("id")
    .where("login_name", "=", "alice")
    .executeTakeFirstOrThrow();
  const bob = (
    await sql<{
      id: string;
    }>`insert into users(login_name) values ('mixedbob') returning id`.execute(
      db,
    )
  ).rows[0];
  await executeData({
    site: "mixedbob",
    adminUserId: bob.id,
    method: "POST",
    path: [],
    body: { name: "feed", read: "world", write: "admin" },
  });
  const own = naru.collection("feed");
  const other = createNaru({ site: "mixedbob" }).collection("feed");
  const ownAdmin = admin.collection("feed");
  const fixtures = await db
    .selectFrom("site_data_collections")
    .select(["id", "user_id"])
    .where("name", "=", "feed")
    .execute();
  const ownId = fixtures.find((c) => c.user_id === alice.id)!.id;
  const otherId = fixtures.find((c) => c.user_id === bob.id)!.id;
  async function seed(collectionId: string, payloadBytes: number) {
    await db
      .deleteFrom("site_data_documents")
      .where("collection_id", "=", collectionId)
      .execute();
    await sql`insert into site_data_documents(collection_id,id,data,size_bytes)
      select ${collectionId}::integer, 'post_' || n, data, octet_length(data::text)
      from (select n, jsonb_build_object('rank', n, 'payload', repeat('x', ${payloadBytes}::integer)) data from generate_series(1,500) n) fixture`.execute(
      db,
    );
  }
  await seed(otherId, 256);
  await seed(ownId, 256);

  // Observe SDK transport and origin cache policy without retaining document
  // data or credentials. Node fetch and this adapter have no shared cache.
  const cacheProbes: unknown[] = [];
  const previousFetch = globalThis.fetch;
  let probe = "";
  globalThis.fetch = async (input, init) => {
    const response = await previousFetch(input, init);
    if (probe)
      cacheProbes.push({
        probe,
        method: init?.method ?? "GET",
        fetchCache: init?.cache,
        fresh: new URL(String(input)).searchParams.get("fresh") === "1",
        credentialed: new Headers(init?.headers).has("Authorization"),
        status: response.status,
        cacheControl: response.headers.get("cache-control"),
        vary: response.headers.get("vary"),
      });
    return response;
  };
  try {
    probe = "anonymous before write";
    await own.get("post_1");
    probe = "other site before write";
    await other.get("post_1");
    probe = "admin write";
    await ownAdmin.set("post_1", { rank: 1, payload: "x".repeat(256) });
    probe = "anonymous after write";
    await own.get("post_1");
    probe = "other site after write";
    await other.get("post_1");
    probe = "admin read";
    await ownAdmin.get("post_1");
  } finally {
    probe = "";
    globalThis.fetch = previousFetch;
  }

  const results: unknown[] = [];
  for (const payloadBytes of [256, 16384]) {
    // Keep 100-write batches below the API's 64 KiB request-body limit.
    // Reads target an untouched document to retain the selected payload size.
    const payload = "x".repeat(256);
    for (const [scenario, backgroundWorkers, kind] of [
      ["read baseline", 0, "none"],
      ["1 grouped batch writer", 1, "grouped"],
      ["8 grouped batch writers", 8, "grouped"],
      ["32 grouped batch writers", 32, "grouped"],
      ["32 dependent batch writers", 32, "dependent"],
      ["1 dependent batch writer", 1, "dependent"],
      ["8 large-page readers", 8, "list"],
    ] as const) {
      await seed(ownId, payloadBytes);
      for (let i = 0; i < 10; i++) {
        await own.get("post_499");
        await other.get("post_499");
      }
      const batches = Array.from({ length: 100 }, (_, j) => ({
        collection: "feed",
        set: {
          id: kind === "dependent" ? "post_1" : `post_${j + 1}`,
          data: { rank: j + 1, payload },
        },
      }));
      let maxAdmittedWrites = 0;
      let maxQueuedWrites = 0;
      let maxWaiting = 0;
      let maxUsed = 0;
      let queuedSamples = 0;
      let totalSamples = 0;
      const timer = setInterval(() => {
        const admission = siteDataWriteAdmission.state;
        maxAdmittedWrites = Math.max(maxAdmittedWrites, admission.active);
        maxQueuedWrites = Math.max(maxQueuedWrites, admission.queued);
        maxWaiting = Math.max(maxWaiting, pool.waitingCount);
        maxUsed = Math.max(maxUsed, pool.totalCount - pool.idleCount);
        totalSamples++;
        if (pool.waitingCount) queuedSamples++;
      }, 5);
      const loop = monitorEventLoopDelay({ resolution: 10 });
      loop.enable();
      const cpu = process.cpuUsage();
      const started = performance.now();
      const deadline = started + durationMs;
      const traffic = async (
        label: string,
        workers: number,
        operation: () => Promise<unknown>,
      ): Promise<Summary> => {
        const latency: number[] = [];
        const errors: Record<string, number> = {};
        await Promise.all(
          Array.from({ length: workers }, async () => {
            while (performance.now() < deadline) {
              const start = performance.now();
              try {
                await operation();
                latency.push(performance.now() - start);
              } catch (e) {
                const key = (e as { code?: string }).code ?? String(e);
                errors[key] = (errors[key] ?? 0) + 1;
              }
            }
          }),
        );
        latency.sort((a, b) => a - b);
        const percentile = (p: number) =>
          +(
            latency[Math.max(0, Math.ceil(latency.length * p) - 1)] ?? 0
          ).toFixed(2);
        return {
          label,
          workers,
          completed: latency.length,
          errors,
          perSecond: +(
            (latency.length / (performance.now() - started)) *
            1000
          ).toFixed(1),
          p50Ms: percentile(0.5),
          p95Ms: percentile(0.95),
          p99Ms: percentile(0.99),
        };
      };
      let groups: Summary[];
      try {
        groups = await Promise.all([
          traffic("same-site get", 4, () => own.get("post_499")),
          traffic("other-site get", 4, () => other.get("post_499")),
          traffic("background", backgroundWorkers, () =>
            kind === "list" ? own.list({ size: 50 }) : admin.batch(batches),
          ),
        ]);
      } finally {
        clearInterval(timer);
        loop.disable();
      }
      const used = process.cpuUsage(cpu);
      const result = {
        payloadBytes,
        scenario,
        groups,
        maxWaiting,
        maxUsed,
        maxAdmittedWrites,
        maxQueuedWrites,
        queuedSamplePercent: totalSamples
          ? +((queuedSamples / totalSamples) * 100).toFixed(1)
          : 0,
        elapsedMs: +(performance.now() - started).toFixed(1),
        nodeCpuMs: (used.user + used.system) / 1000,
        eventLoopP95Ms: +(loop.percentile(95) / 1e6).toFixed(2),
        eventLoopMaxMs: +(loop.max / 1e6).toFixed(2),
      };
      results.push(result);
      console.log(JSON.stringify(result));
    }
  }
  const dir = resolve(process.env.NARU_STRESS_OUTPUT ?? "stress-results");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    resolve(dir, "sdk-mixed-stress.json"),
    JSON.stringify(
      {
        recordedAt: new Date().toISOString(),
        implementation: "bounded write admission",
        node: process.version,
        poolMax: pool.options.max,
        durationMs,
        documentsPerSite: 500,
        otherSitePayloadBytes: 256,
        writerPayloadBytes: 256,
        readWorkersPerSite: 4,
        boundary:
          "Built SDK + loopback HTTP + actual routes + disposable PostgreSQL; shared Node process; no CDN cache",
        cacheProbes,
        results,
      },
      null,
      2,
    ) + "\n",
  );
  if (
    results.some((r) =>
      (r as { groups: Summary[] }).groups.some(
        (g) => Object.keys(g.errors).length,
      ),
    )
  )
    throw new Error("Mixed workload had errors; inspect sdk-mixed-stress.json");
}
