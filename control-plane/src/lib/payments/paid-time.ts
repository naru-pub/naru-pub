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
  await compactRefundedPaidPeriods(trx, userId);
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

// The caller holds the user/account lock. Keep allocations in memory while
// compacting: an earlier refund may move a later refund's own allocation.
async function compactRefundedPaidPeriods(trx: Executor, userId: string) {
  const rows = await trx
    .selectFrom("payments")
    .select([
      "id",
      "period_start",
      "period_end",
      "refunded_amount",
      "refunded_at",
      "paid_time_revoked_at",
    ])
    .where("user_id", "=", userId)
    .execute();
  const refunds = rows
    .filter((row) => row.refunded_amount > 0 && !row.paid_time_revoked_at)
    .sort(
      (a, b) =>
        (a.refunded_at?.getTime() ?? Infinity) -
          (b.refunded_at?.getTime() ?? Infinity) || a.id.localeCompare(b.id),
    );
  const changed = new Set<(typeof rows)[number]>();
  for (const refund of refunds) {
    const start = refund.period_start?.getTime();
    const end = refund.period_end?.getTime();
    const replacement =
      start !== undefined &&
      end !== undefined &&
      rows.some(
        (row) =>
          row.refunded_amount === 0 &&
          row.period_start &&
          row.period_end &&
          row.period_start.getTime() < end &&
          row.period_end.getTime() > start,
      );
    if (
      start !== undefined &&
      end !== undefined &&
      end > start &&
      !replacement
    ) {
      const removed = end - start;
      let frontier = end;
      const queued = rows
        .filter(
          (row) =>
            row.id !== refund.id &&
            row.period_start &&
            row.period_end &&
            row.period_start.getTime() >= end,
        )
        .sort(
          (a, b) =>
            a.period_start!.getTime() - b.period_start!.getTime() ||
            a.period_end!.getTime() - b.period_end!.getTime() ||
            a.id.localeCompare(b.id),
        );
      for (const row of queued) {
        const queuedStart = row.period_start!.getTime();
        const queuedEnd = row.period_end!.getTime();
        if (queuedStart > frontier) break; // preserve independent purchases after a gap
        frontier = Math.max(frontier, queuedEnd);
        row.period_start = new Date(queuedStart - removed);
        row.period_end = new Date(queuedEnd - removed);
        changed.add(row);
      }
    }
    refund.paid_time_revoked_at = new Date();
    changed.add(refund);
  }
  for (const row of changed)
    await trx
      .updateTable("payments")
      .set({
        period_start: row.period_start,
        period_end: row.period_end,
        paid_time_revoked_at: row.paid_time_revoked_at,
      })
      .where("id", "=", row.id)
      .execute();
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
