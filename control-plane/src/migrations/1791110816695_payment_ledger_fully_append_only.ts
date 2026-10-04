import { sql, type Kysely } from "kysely";

export async function up(db: Kysely<any>): Promise<void> {
  await sql`create or replace trigger payment_transactions_no_update
    before update or delete on payment_transactions
    for each row execute function payment_transactions_append_only()`.execute(
    db,
  );
  // TRUNCATE (including cascades from another table) does not fire row triggers.
  await sql`create trigger payment_transactions_no_truncate
    before truncate on payment_transactions
    for each statement execute function payment_transactions_append_only()`.execute(
    db,
  );
}

export async function down(_db: Kysely<any>): Promise<void> {
  throw new Error(
    "Deploy a forward fix; payment ledger history must remain append-only",
  );
}
