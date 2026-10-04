import { sql, type Kysely } from "kysely";

// Historical repair remains frozen in the preceding migration. Application
// refunds now compact allocations in TypeScript within their transaction.
export async function up(db: Kysely<any>): Promise<void> {
  await sql`drop function compact_refunded_paid_periods(uuid)`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DO $$ BEGIN RAISE EXCEPTION 'Deploy a forward fix; refund compaction now runs in TypeScript'; END $$`.execute(
    db,
  );
}
