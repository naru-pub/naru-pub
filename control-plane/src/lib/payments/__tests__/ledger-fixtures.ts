import { sql, type Kysely, type RawBuilder } from "kysely";
import type { DB } from "@/lib/db";

// Disposable database fixtures only. Table locks and transactional DDL keep
// the guards disabled only during reset, and rollback restores them on error.
export async function resetLedgerFixtures(
  db: Kysely<DB>,
  reset: RawBuilder<unknown>,
) {
  if (
    process.env.NARU_PAYMENTS_DB_TEST !== "1" &&
    process.env.NARU_BOARD_TEST !== "1"
  ) {
    throw new Error("Ledger reset is restricted to disposable database tests");
  }
  await db.transaction().execute(async (trx) => {
    const {
      rows: [database],
    } = await sql<{ name: string }>`select current_database() as name`.execute(
      trx,
    );
    if (!["naru_payments_test", "naru_board_test"].includes(database.name)) {
      throw new Error(
        "Ledger reset is restricted to disposable test databases",
      );
    }
    await sql`alter table payment_transactions disable trigger payment_transactions_no_update`.execute(
      trx,
    );
    await sql`alter table payment_transactions disable trigger payment_transactions_no_truncate`.execute(
      trx,
    );
    await reset.execute(trx);
    await sql`alter table payment_transactions enable trigger payment_transactions_no_update`.execute(
      trx,
    );
    await sql`alter table payment_transactions enable trigger payment_transactions_no_truncate`.execute(
      trx,
    );
  });
}
