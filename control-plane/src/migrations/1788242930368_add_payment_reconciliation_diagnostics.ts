import type { Kysely } from "kysely";

// `any` is required here since migrations should be frozen in time. alternatively, keep a "snapshot" db interface.
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable("payments")
    .addColumn("last_reconciled_at", "timestamptz")
    .addColumn("reconciliation_error", "text")
    .execute();
}

// `any` is required here since migrations should be frozen in time. alternatively, keep a "snapshot" db interface.
export async function down(db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable("payments")
    .dropColumn("reconciliation_error")
    .dropColumn("last_reconciled_at")
    .execute();
}
