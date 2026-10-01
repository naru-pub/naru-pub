import { db } from "@/lib/database";
import { AccountBusyError } from "@/lib/account-lock";
import { notePaymentEvent, won } from "@/lib/payment-events";
import { reconcilePayment } from "@/lib/payment-reconciliation";
import {
  listTransactions,
  tossSecretKeys,
  type TossTransaction,
} from "@/lib/toss";

// Once a day, the books against the money: every transaction Toss recorded
// for a day (GET /v1/transactions, both MIDs) against payment_transactions.
// Everything else here trusts what Toss told us about orders we already knew;
// this finds what it did not — a charge approved that we never recorded, a
// cancel made in the dashboard whose webhook never came, a ledger row Toss
// has no record of. An order whose counts differ is reconciled first (which
// fixes a missed cancel or a late approval); what still differs is reported
// as one toss_mismatch event.

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
// Transactions that moved money; READY, IN_PROGRESS and the like did not.
const MONEY_MOVED = new Set(["DONE", "CANCELED", "PARTIAL_CANCELED"]);
const MAX_PAGES = 100;

// The KST day before `now`, as Toss's local times and as instants.
export function previousKstDay(now = new Date()) {
  const kstMidnight =
    Math.floor((now.getTime() + KST_OFFSET_MS) / DAY_MS) * DAY_MS;
  const start = new Date(kstMidnight - DAY_MS - KST_OFFSET_MS);
  const end = new Date(kstMidnight - KST_OFFSET_MS);
  const local = (at: Date) =>
    new Date(at.getTime() + KST_OFFSET_MS).toISOString().slice(0, 19);
  return { start, end, startLocal: local(start), endLocal: local(end) };
}

// Toss's list names a billing order with a prefix before our order id
// ("1a5321_2026-10-01-7267-3808"); our ids have no underscore.
function ourOrderId(orderId: string): string {
  const at = orderId.indexOf("_");
  return at === -1 ? orderId : orderId.slice(at + 1);
}

// Both MIDs' transactions, each once: with test keys both secret keys can
// list the same account.
async function tossTransactions(startLocal: string, endLocal: string) {
  const all = new Map<string, TossTransaction>();
  for (const { flow } of tossSecretKeys()) {
    let startingAfter: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const rows = await listTransactions(flow, {
        startDate: startLocal,
        endDate: endLocal,
        startingAfter,
      });
      for (const row of rows) {
        all.set(row.transactionKey, {
          ...row,
          orderId: ourOrderId(row.orderId),
        });
      }
      if (rows.length < 5000) break;
      startingAfter = rows[rows.length - 1].transactionKey;
    }
  }
  return [...all.values()];
}

async function ledgerCounts(start: Date, end: Date, orderIds?: string[]) {
  const rows = await db
    .selectFrom("payment_transactions as t")
    .innerJoin("payments as p", "p.id", "t.payment_id")
    .select(["p.order_id", (eb) => eb.fn.countAll<number>().as("n")])
    .where("t.occurred_at", ">=", start)
    .where("t.occurred_at", "<", end)
    .$if(orderIds !== undefined, (qb) =>
      qb.where("p.order_id", "in", orderIds!),
    )
    .groupBy("p.order_id")
    .execute();
  return new Map(rows.map((row) => [row.order_id, Number(row.n)]));
}

export async function checkTossTransactions(now = new Date()): Promise<{
  day: string;
  transactions: number;
  problems: string[];
}> {
  const { start, end, startLocal, endLocal } = previousKstDay(now);
  const toss = (await tossTransactions(startLocal, endLocal)).filter((t) =>
    MONEY_MOVED.has(t.status),
  );
  const tossByOrder = new Map<string, TossTransaction[]>();
  for (const t of toss) {
    tossByOrder.set(t.orderId, [...(tossByOrder.get(t.orderId) ?? []), t]);
  }

  const orderIds = [...tossByOrder.keys()];
  const payments = orderIds.length
    ? await db
        .selectFrom("payments")
        .select(["id", "order_id"])
        .where("order_id", "in", orderIds)
        .execute()
    : [];
  const paymentByOrder = new Map(payments.map((p) => [p.order_id, p.id]));

  const problems: string[] = [];
  let ledger = await ledgerCounts(start, end);
  // Orders whose day at Toss and in the ledger differ: reconciled, then
  // counted again.
  const differing = orderIds.filter(
    (orderId) =>
      paymentByOrder.has(orderId) &&
      (ledger.get(orderId) ?? 0) !== tossByOrder.get(orderId)!.length,
  );
  for (const orderId of differing) {
    try {
      await reconcilePayment(paymentByOrder.get(orderId)!, { waitMs: 0 });
    } catch (error) {
      if (!(error instanceof AccountBusyError)) {
        console.error(
          `[toss-transactions] reconciling ${orderId} failed`,
          error,
        );
      }
    }
  }
  if (differing.length > 0) {
    const recounted = await ledgerCounts(start, end, differing);
    ledger = new Map([...ledger, ...recounted]);
    for (const orderId of differing) {
      if (!recounted.has(orderId)) ledger.delete(orderId);
    }
  }

  for (const [orderId, transactions] of tossByOrder) {
    const amount = won(transactions.reduce((t, x) => t + x.amount, 0));
    if (!paymentByOrder.has(orderId)) {
      problems.push(
        `Toss에만 있는 주문 ${orderId}: 거래 ${transactions.length}건 (${amount})`,
      );
    } else if ((ledger.get(orderId) ?? 0) !== transactions.length) {
      problems.push(
        `주문 ${orderId}: Toss 거래 ${transactions.length}건, 원장 ${ledger.get(orderId) ?? 0}건`,
      );
    }
  }
  for (const [orderId, count] of ledger) {
    if (!tossByOrder.has(orderId)) {
      problems.push(`원장에만 있는 거래: 주문 ${orderId} ${count}건`);
    }
  }

  const day = startLocal.slice(0, 10);
  if (problems.length > 0) {
    await notePaymentEvent({
      kind: "toss_mismatch",
      summary: `${day} Toss 거래와 원장이 ${problems.length}건 다름: ${problems.slice(0, 5).join(" · ")}${problems.length > 5 ? " …" : ""}`,
    });
  }
  return { day, transactions: toss.length, problems };
}
