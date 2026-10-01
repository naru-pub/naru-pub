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
  const ledger = await trx
    .selectFrom("payments")
    .select([
      "period_start",
      "period_end",
      "paid_at",
      "amount",
      "refunded_amount",
    ])
    .where("user_id", "=", userId)
    .where("period_end", "is not", null)
    .execute();
  const recomputed = supporterUntilFromLedger(
    ledger.map((row) => ({
      periodStart: row.period_start,
      periodEnd: row.period_end,
      paidAt: row.paid_at,
      amount: row.amount,
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
    .execute();
}

export type EntitlementLedgerRow = {
  periodStart?: Date | string | null;
  periodEnd: Date | string | null;
  paidAt?: Date | string | null;
  amount: number;
  refundedAmount: number;
};

// supporter_until is where the periods the unrefunded payments bought end. A
// refunded payment stops counting, so the time it granted goes back with the
// money. 나루 does not offer partial refunds, so any refunded amount undoes the
// whole purchase rather than a slice of it.
//
// Purchases stack: one bought while time remained starts where that time ended.
// So the ledger is replayed in order, and a period that was queued behind a
// refunded one moves up — but never earlier than it was paid for, and never
// later than it was recorded. A period that did not stack keeps its dates.
export function supporterUntilFromLedger(
  rows: EntitlementLedgerRow[],
): Date | null {
  const periods = rows
    .filter((row) => row.periodEnd)
    .map((row) => ({
      start: row.periodStart ? new Date(row.periodStart) : null,
      end: new Date(row.periodEnd!),
      paidAt: row.paidAt ? new Date(row.paidAt) : null,
      refunded: row.refundedAmount > 0,
    }))
    .sort(
      (a, b) =>
        (a.start ?? a.end).getTime() - (b.start ?? b.end).getTime() ||
        a.end.getTime() - b.end.getTime(),
    );

  let cursor: Date | null = null;
  let latest: Date | null = null;
  for (const period of periods) {
    if (period.refunded) continue;
    let end = period.end;
    if (period.start && period.paidAt) {
      const earliest =
        cursor && cursor > period.paidAt ? cursor : period.paidAt;
      if (earliest < period.start) {
        end = new Date(
          period.end.getTime() - (period.start.getTime() - earliest.getTime()),
        );
      }
    }
    if (!cursor || end > cursor) cursor = end;
    if (!latest || end > latest) latest = end;
  }
  return latest;
}
