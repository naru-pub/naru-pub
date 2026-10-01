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
      for (const row of rows) all.set(row.transactionKey, row);
      if (rows.length < 5000) break;
      startingAfter = rows[rows.length - 1].transactionKey;
    }
  }
  return [...all.values()];
}

// The ledger's rows for the day, counted by payment.
async function ledgerCounts(start: Date, end: Date, paymentIds?: string[]) {
  const rows = await db
    .selectFrom("payment_transactions")
    .select(["payment_id", (eb) => eb.fn.countAll<number>().as("n")])
    .where("occurred_at", ">=", start)
    .where("occurred_at", "<", end)
    .$if(paymentIds !== undefined, (qb) =>
      qb.where("payment_id", "in", paymentIds!),
    )
    .groupBy("payment_id")
    .execute();
  return new Map(rows.map((row) => [row.payment_id, Number(row.n)]));
}

// Which of our payments each Toss transaction belongs to: by its paymentKey,
// which Toss gives every transaction and we keep (toss_payment_key) once
// Toss has answered for the payment, or else by its exact orderId. Toss's
// list may write the orderId differently from what we sent (it prefixes
// billing orders in test mode), and that is not documented, so it is never
// pulled apart; a transaction matching neither is reported. By the time this
// runs, the reconciler has settled yesterday's open orders and learned their
// paymentKeys.
async function ourPayments(transactions: TossTransaction[]) {
  const paymentKeys = [...new Set(transactions.map((t) => t.paymentKey))];
  const orderIds = [...new Set(transactions.map((t) => t.orderId))];
  const rows =
    transactions.length === 0
      ? []
      : await db
          .selectFrom("payments")
          .select(["id", "order_id", "toss_payment_key"])
          .where((eb) =>
            eb.or([
              eb("toss_payment_key", "in", paymentKeys),
              eb("order_id", "in", orderIds),
            ]),
          )
          .execute();
  const byKey = new Map(
    rows
      .filter((row) => row.toss_payment_key)
      .map((row) => [row.toss_payment_key!, row]),
  );
  const byOrder = new Map(rows.map((row) => [row.order_id, row]));
  return (t: TossTransaction) =>
    byKey.get(t.paymentKey) ?? byOrder.get(t.orderId) ?? null;
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
  const paymentOf = await ourPayments(toss);
  const problems: string[] = [];

  // Toss's transactions by our payment; those of no payment of ours, by the
  // order Toss names.
  const tossByPayment = new Map<string, TossTransaction[]>();
  const orderOf = new Map<string, string>();
  const unknown = new Map<string, TossTransaction[]>();
  for (const t of toss) {
    const payment = paymentOf(t);
    if (payment) {
      tossByPayment.set(payment.id, [
        ...(tossByPayment.get(payment.id) ?? []),
        t,
      ]);
      orderOf.set(payment.id, payment.order_id);
    } else {
      unknown.set(t.orderId, [...(unknown.get(t.orderId) ?? []), t]);
    }
  }

  let ledger = await ledgerCounts(start, end);
  // Payments whose day at Toss and in the ledger differ: reconciled, then
  // counted again.
  const differing = [...tossByPayment.keys()].filter(
    (id) => (ledger.get(id) ?? 0) !== tossByPayment.get(id)!.length,
  );
  for (const id of differing) {
    try {
      await reconcilePayment(id, { waitMs: 0 });
    } catch (error) {
      if (!(error instanceof AccountBusyError)) {
        console.error(`[toss-transactions] reconciling ${id} failed`, error);
      }
    }
  }
  if (differing.length > 0) {
    const recounted = await ledgerCounts(start, end, differing);
    for (const id of differing) ledger.delete(id);
    ledger = new Map([...ledger, ...recounted]);
  }

  for (const [orderId, transactions] of unknown) {
    const amount = won(transactions.reduce((t, x) => t + x.amount, 0));
    problems.push(
      `Toss에만 있는 주문 ${orderId}: 거래 ${transactions.length}건 (${amount})`,
    );
  }
  for (const [id, transactions] of tossByPayment) {
    if ((ledger.get(id) ?? 0) !== transactions.length) {
      problems.push(
        `주문 ${orderOf.get(id)}: Toss 거래 ${transactions.length}건, 원장 ${ledger.get(id) ?? 0}건`,
      );
    }
  }
  const ledgerOnly = [...ledger.keys()].filter((id) => !tossByPayment.has(id));
  if (ledgerOnly.length > 0) {
    const rows = await db
      .selectFrom("payments")
      .select("order_id")
      .where("id", "in", ledgerOnly)
      .execute();
    for (const row of rows) {
      problems.push(`원장에만 있는 거래: 주문 ${row.order_id}`);
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
