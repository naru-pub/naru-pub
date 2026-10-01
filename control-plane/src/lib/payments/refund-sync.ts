import { sql } from "kysely";
import { db } from "@/lib/database";
import { AccountBusyError } from "@/lib/payments/account-lock";
import { reconcilePayment } from "@/lib/payments/payment-reconciliation";
import { REFUND_WINDOW_DAYS } from "@/lib/payments/refunds";

const DAY_MS = 24 * 60 * 60 * 1000;

// How often a paid payment is asked about again depends on its age, because
// how likely a refund is depends on it
// (https://docs.tosspayments.com/guides/v2/cancel-payment):
//
// - Inside 나루's own refund window, supporters refund themselves, and
//   operators and card disputes are most likely soon after paying: daily.
// - A card payment has no cancellation deadline at Toss, but card companies
//   keep payment data for about a year, so past that a cancel "may not work".
//   Up to then an operator or the Toss dashboard can still cancel: weekly.
// - Toss answers lookups for payments up to five years old; a cancel that late
//   is unlikely but not impossible, and the ledger should still learn of it:
//   monthly. Past five years Toss cannot be asked any more.
//
// The webhook (PAYMENT_STATUS_CHANGED → CANCELED / PARTIAL_CANCELED) is the
// fast path for all of these; this sweep is what catches a missed one.
export const REFUND_SYNC_TIERS = [
  { maxAgeDays: REFUND_WINDOW_DAYS + 30, everyDays: 1 },
  { maxAgeDays: 400, everyDays: 7 },
  { maxAgeDays: 5 * 365, everyDays: 30 },
] as const;

const BATCH_SIZE = 500;

// Payments in a tier whose last check is older than the tier's interval.
// paid_at is when the money moved; older rows that predate it fall back to
// created_at. A small slack keeps a daily check from slipping to every other
// day when one run starts a few minutes earlier than the last.
function dueCondition(now: Date) {
  const slackMs = 60 * 60 * 1000;
  const tiers = REFUND_SYNC_TIERS.map((tier, index) => {
    const youngest =
      index === 0 ? null : REFUND_SYNC_TIERS[index - 1].maxAgeDays;
    const paidAfter = new Date(now.getTime() - tier.maxAgeDays * DAY_MS);
    const paidBefore =
      youngest === null ? null : new Date(now.getTime() - youngest * DAY_MS);
    const checkedBefore = new Date(
      now.getTime() - tier.everyDays * DAY_MS + slackMs,
    );
    return sql`(
      coalesce(paid_at, created_at) >= ${paidAfter}
      ${paidBefore ? sql`AND coalesce(paid_at, created_at) < ${paidBefore}` : sql``}
      AND (last_reconciled_at IS NULL OR last_reconciled_at < ${checkedBefore})
    )`;
  });
  return sql<boolean>`(${sql.join(tiers, sql` OR `)})`;
}

type Cursor = { lastChecked: Date; id: string };

const lastChecked = sql<Date>`coalesce(last_reconciled_at, 'epoch'::timestamptz)`;

// Keyset over (last check, id). A checked row's last_reconciled_at moves to
// now, which takes it out of the due set; a check that failed without being
// recorded keeps its old position, which is behind the cursor. Either way no
// row is visited twice in one run.
async function duePage(
  now: Date,
  after: Cursor | null,
): Promise<Array<{ id: string; lastChecked: Date }>> {
  const rows = await db
    .selectFrom("payments")
    .select(["id", lastChecked.as("last_checked")])
    // Done, or refunded in part from the Toss dashboard: more of it may be
    // refunded yet.
    .where((eb) =>
      eb.or([
        eb("status", "=", "done"),
        eb.and([
          eb("status", "=", "canceled"),
          eb("refunded_amount", "<", eb.ref("amount")),
        ]),
      ]),
    )
    .where(dueCondition(now))
    .$if(after !== null, (qb) =>
      qb.where(
        sql<boolean>`(${lastChecked}, id) > (${after!.lastChecked}::timestamptz, ${after!.id}::uuid)`,
      ),
    )
    .orderBy(lastChecked, "asc")
    .orderBy("id", "asc")
    .limit(BATCH_SIZE)
    .execute();
  return rows.map((row) => ({ id: row.id, lastChecked: row.last_checked }));
}

export type RefundSyncResult = {
  checked: number;
  refunded: number;
  failed: number;
  // True when the time budget ran out first; the rest stay due and the next
  // run starts with them.
  incomplete: boolean;
};

// Checks every paid payment that is due, most overdue first, in pages. There
// is no cap on how many: a run stops only when nothing due is left or its time
// budget is spent. Most overdue first means a run that runs out of time never
// starves the same payments twice — what it did not reach waited longest and
// leads the next run.
export async function syncPaymentRefunds(
  opts: { now?: Date; budgetMs?: number } = {},
): Promise<RefundSyncResult> {
  const now = opts.now ?? new Date();
  const deadline = Date.now() + (opts.budgetMs ?? Number.POSITIVE_INFINITY);
  const result: RefundSyncResult = {
    checked: 0,
    refunded: 0,
    failed: 0,
    incomplete: false,
  };

  let cursor: Cursor | null = null;
  for (;;) {
    const page = await duePage(now, cursor);
    if (page.length === 0) return result;
    const last = page[page.length - 1];
    cursor = { lastChecked: last.lastChecked, id: last.id };

    for (const payment of page) {
      if (Date.now() >= deadline) {
        result.incomplete = true;
        return result;
      }
      result.checked += 1;
      try {
        // Without waiting: an account busy with another payment operation
        // stays due, and the next run (or this one's next page) gets it.
        const outcome = await reconcilePayment(payment.id, { waitMs: 0 });
        if (outcome.state === "refunded") {
          result.refunded += 1;
          console.log(
            `[sync-payment-refunds] payment ${payment.id}: refund ${outcome.amount}`,
          );
        }
      } catch (error) {
        if (error instanceof AccountBusyError) {
          result.checked -= 1;
          continue;
        }
        result.failed += 1;
        console.error(
          `[sync-payment-refunds] payment ${payment.id}: sync failed`,
          error,
        );
      }
    }
  }
}
