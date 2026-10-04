import { sql } from "kysely";
import type { Executor } from "@/lib/entitlements";

// users.supporter_until — the paid time the proxy and the entitlement layer
// gate on — is written here and nowhere else (billing-key-writes-payment.test.ts
// keeps it so). A grant extends it to the end of the period it bought, and
// never shortens it; a refund recomputes it from the ledger of what the
// unrefunded payments paid for, and never lengthens it. Lifetime comps live on
// supporter_comp and are not touched.

// Locks the account's paid time for a grant and reads it. FOR NO KEY UPDATE
// serializes grants without blocking the key-share lock a payment_events
// insert takes on the user, which a transaction holding the plan may need.
// Grants and refunds take locks in one order: payments, users, subscriptions.
export async function lockPaidTime(
  trx: Executor,
  userId: string,
): Promise<Date | null> {
  const row = await trx
    .selectFrom("users")
    .select("supporter_until")
    .where("id", "=", userId)
    .forNoKeyUpdate()
    .executeTakeFirstOrThrow();
  return row.supporter_until ? new Date(row.supporter_until) : null;
}

// A grant: paid time now runs to `until`, or stays later if it already does.
export async function extendPaidTime(
  trx: Executor,
  userId: string,
  until: Date,
): Promise<void> {
  await trx
    .updateTable("users")
    .set({
      supporter_until: sql<Date>`greatest(coalesce(supporter_until, ${until}), ${until})`,
    })
    .where("id", "=", userId)
    .where("deleted_at", "is", null)
    .execute();
}

// After a refund: paid time is where the periods the unrefunded payments
// bought end (supporterUntilFromLedger). Only ever shortens. Callers have
// locked the user (lockPaidTime) before reading or writing the payments, so a
// grant running alongside is in the ledger read here.
export async function recomputePaidTime(
  trx: Executor,
  userId: string,
): Promise<Date | null> {
  const current = await lockPaidTime(trx, userId);
  await sql`select compact_refunded_paid_periods(${userId}::uuid)`.execute(trx);
  const ledger = await trx
    .selectFrom("payments")
    .select(["period_end", "refunded_amount"])
    .where("user_id", "=", userId)
    .where("period_end", "is not", null)
    .execute();
  const recomputed = supporterUntilFromLedger(
    ledger.map((row) => ({
      periodEnd: row.period_end,
      refundedAmount: row.refunded_amount,
    })),
  );
  if (current && (recomputed === null || recomputed < current)) {
    await trx
      .updateTable("users")
      .set({ supporter_until: recomputed })
      .where("id", "=", userId)
      .execute();
  }
  return recomputed;
}

// The billing lab's clock: paid time set to a moment of its choosing, with
// test keys only.
export async function movePaidTimeForLab(
  trx: Executor,
  userId: string,
  until: Date,
): Promise<void> {
  await trx
    .updateTable("users")
    .set({ supporter_until: until })
    .where("id", "=", userId)
    .where("deleted_at", "is", null)
    .execute();
}

export type EntitlementLedgerRow = {
  periodEnd: Date | string | null;
  refundedAmount: number;
};

// supporter_until is where the latest period an unrefunded payment bought
// ends. A refunded payment stops counting, so the time it granted goes back
// with the money. 나루 does not offer partial refunds, so any refunded amount
// undoes the whole purchase rather than a slice of it.
//
// Refunded allocations are compacted transactionally before this projection.
// Remaining payments keep their purchased duration, with queued periods moved
// forward; independent periods after a gap keep their dates.
export function supporterUntilFromLedger(
  rows: EntitlementLedgerRow[],
): Date | null {
  let latest: Date | null = null;
  for (const row of rows) {
    if (!row.periodEnd || row.refundedAmount > 0) continue;
    const end = new Date(row.periodEnd);
    if (!latest || end > latest) latest = end;
  }
  return latest;
}
