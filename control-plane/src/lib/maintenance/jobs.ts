import { sql, type Kysely, type Transaction } from "kysely";
import type { DB } from "@/lib/db";

export const MAINTENANCE_QUEUE = "maintenance";
export const MAINTENANCE_TASK = "maintenance-job-v1";
export const MAINTENANCE_RETRY_OPTIONS = {
  max_attempts: 8,
  retry_strategy: {
    kind: "exponential",
    base_seconds: 60,
    factor: 2,
    max_seconds: 600,
  },
} as const;

// Times are UTC. Daily slots start at their scheduled time, not midnight, so
// deployment catch-up before today's scheduled time belongs to yesterday's run.
export const MAINTENANCE_JOBS = [
  {
    name: "screenshot-updater",
    script: "update-screenshots.tsx",
    minutes: 15,
    timeout: 600,
  },
  {
    name: "export-processor",
    script: "process-exports.ts",
    minutes: 2,
    timeout: 1800,
  },
  {
    name: "site-update-dispatcher",
    script: "dispatch-site-updates.ts",
    minutes: 5,
    timeout: 300,
  },
  {
    name: "custom-domain-refresher",
    script: "refresh-custom-domains.ts",
    minutes: 3,
    timeout: 120,
  },
  {
    name: "payment-reconciliation",
    script: "reconcile-payments.ts",
    minutes: 5,
    timeout: 120,
    payment: true,
  },
  {
    name: "billing-key-deletion",
    script: "delete-retired-billing-keys.ts",
    minutes: 5,
    timeout: 120,
    payment: true,
  },
  {
    name: "payment-event-digest",
    script: "send-payment-event-digest.ts",
    minutes: 1,
    timeout: 120,
  },
  {
    name: "github-deployment-cleanup",
    script: "cleanup-expired-github-deployments.ts",
    minutes: 15,
    timeout: 300,
  },
  {
    name: "media-cleanup",
    script: "cleanup-pending-media.ts",
    minutes: 15,
    timeout: 300,
  },
  {
    name: "site-data-grant-cleanup",
    script: "cleanup-site-data-grants.ts",
    minutes: 30,
    timeout: 300,
  },
  {
    name: "home-directory-updater",
    script: "update-home-directory-sizes.ts",
    minutes: 1440,
    hour: 13,
    minute: 0,
    timeout: 1800,
  },
  {
    name: "payment-refund-sync",
    script: "sync-payment-refunds.ts",
    minutes: 1440,
    hour: 19,
    minute: 15,
    timeout: 3600,
    payment: true,
  },
  {
    name: "billing-notifications",
    script: "send-billing-notifications.ts",
    minutes: 1440,
    hour: 0,
    minute: 0,
    timeout: 300,
    payment: true,
  },
  {
    name: "expired-custom-domain-cleanup",
    script: "cleanup-expired-custom-domains.ts",
    minutes: 1440,
    hour: 19,
    minute: 30,
    timeout: 300,
  },
  {
    name: "toss-transaction-check",
    script: "check-toss-transactions.ts",
    minutes: 1440,
    hour: 19,
    minute: 45,
    timeout: 1800,
    payment: true,
  },
  {
    name: "payment-invariant-check",
    script: "check-payment-invariants.ts",
    minutes: 1440,
    hour: 20,
    minute: 0,
    timeout: 600,
    payment: true,
  },
] as const;
export const SCHEDULED_JOBS = [
  { name: "worker", everySeconds: 60 },
  { name: "subscription-charger", everySeconds: 3600 },
  ...MAINTENANCE_JOBS.map((job) => ({
    name: job.name,
    everySeconds: job.minutes * 60,
  })),
];

export type MaintenanceName =
  | (typeof MAINTENANCE_JOBS)[number]["name"]
  | "template-preview";
export type MaintenanceJob = {
  name: MaintenanceName;
  script: string;
  minutes: number;
  timeout: number;
  hour?: number;
  minute?: number;
  payment?: boolean;
  args?: string[];
  lock?: string;
};
export function maintenanceJob(name: MaintenanceName): MaintenanceJob {
  if (name === "template-preview")
    return {
      name,
      script: "update-screenshots.tsx",
      args: ["--templates"],
      minutes: 15,
      timeout: 600,
      lock: "screenshot-updater",
    };
  const job = MAINTENANCE_JOBS.find((job) => job.name === name);
  if (!job) throw new Error(`Unknown maintenance job: ${name}`);
  return job;
}

// SQL only: publication and its durable work commit or roll back together.
export async function enqueueTemplatePreview(
  executor: Kysely<DB> | Transaction<DB>,
  versionId: string,
): Promise<void> {
  await sql`select absurd.spawn_task(${MAINTENANCE_QUEUE}, ${MAINTENANCE_TASK},
    ${JSON.stringify({ name: "template-preview" })}::jsonb,
    ${JSON.stringify({ ...MAINTENANCE_RETRY_OPTIONS, idempotency_key: `template-preview:${versionId}` })}::jsonb)
  `.execute(executor);
}

// Absurd's built-in terminal-task cleanup bounds frequent maintenance history.
// Payment intents and unfinished maintenance work are outside this cleanup.
export async function pruneMaintenanceTasks(
  executor: Kysely<DB>,
): Promise<number> {
  const {
    rows: [row],
  } = await sql<{ deleted: number }>`
    select absurd.cleanup_tasks(${MAINTENANCE_QUEUE}, ${30 * 86400}, 1000) as deleted
  `.execute(executor);
  return row.deleted;
}
