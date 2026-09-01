import type { Kysely } from "kysely";

// `any` is required here since migrations should be frozen in time. alternatively, keep a "snapshot" db interface.
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable("payments")
    .addColumn("refunded_amount", "integer", (column) =>
      column.notNull().defaultTo(0),
    )
    .addColumn("refunded_at", "timestamptz")
    .execute();
}

// `any` is required here since migrations should be frozen in time. alternatively, keep a "snapshot" db interface.
export async function down(db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable("payments")
    .dropColumn("refunded_at")
    .dropColumn("refunded_amount")
    .execute();
}
