import { sql, type Kysely } from "kysely";

// A refund stops the account's recurring plan only when that plan already
// existed when the refund happened (payment-reconciliation.ts). The
// subscriptions row is reused across signups, so when the current plan began
// is recorded on it: plan_started_at, set by each signup's prepare. No real
// subscription predates the column; the default only fills test-mode rows.
//
// refund_keeps_plan marks a refund an operator made without ending the plan —
// a duplicate charge given back, say. It is set before Toss is asked to cancel,
// so the webhook reconciling that cancel honours it too.
// `any` is required here since migrations should be frozen in time.
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable("subscriptions")
    .addColumn("plan_started_at", "timestamptz", (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .execute();
  await db.schema
    .alterTable("payments")
    .addColumn("refund_keeps_plan", "boolean", (col) =>
      col.notNull().defaultTo(false),
    )
    .execute();
}

// `any` is required here since migrations should be frozen in time.
export async function down(db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable("payments")
    .dropColumn("refund_keeps_plan")
    .execute();
  await db.schema
    .alterTable("subscriptions")
    .dropColumn("plan_started_at")
    .execute();
}
