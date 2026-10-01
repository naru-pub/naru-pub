import { sql } from "kysely";
import type { Executor } from "@/lib/entitlements";
import type { TossPaymentResult } from "@/lib/toss";

// The append-only record of money that moved (payment_transactions, see the
// migration that adds it): the approval of each payment and every cancel Toss
// made of it. Written in the transaction that applies the change to the
// payment, so the two agree; payments.refunded_amount is read back from here.

// Records that Toss approved the payment. Once per payment.
export async function recordApproval(
  trx: Executor,
  opts: { paymentId: string; amount: number; at: Date },
): Promise<void> {
  await trx
    .insertInto("payment_transactions")
    .values({
      payment_id: opts.paymentId,
      kind: "approval",
      amount: opts.amount,
      transaction_key: `approval:${opts.paymentId}`,
      occurred_at: opts.at,
    })
    .onConflict((oc) => oc.doNothing())
    .execute();
}

// Records the cancels Toss reports for the payment, each once, and returns
// how much has been refunded in all and when the latest cancel was. A cancel
// Toss gives no transactionKey is keyed by its place in the list, which Toss
// only appends to.
export async function recordCancels(
  trx: Executor,
  opts: { paymentId: string; payment: TossPaymentResult; fallbackAt: Date },
): Promise<{ refundedAmount: number; refundedAt: Date | null }> {
  const cancels = (opts.payment.cancels ?? []).filter(
    (cancel) => cancel.cancelAmount > 0,
  );
  for (const [index, cancel] of cancels.entries()) {
    const at = cancel.canceledAt ? new Date(cancel.canceledAt) : null;
    await trx
      .insertInto("payment_transactions")
      .values({
        payment_id: opts.paymentId,
        kind: "cancel",
        amount: cancel.cancelAmount,
        transaction_key:
          cancel.transactionKey ?? `cancel:${opts.payment.paymentKey}:${index}`,
        occurred_at: at && !Number.isNaN(at.getTime()) ? at : opts.fallbackAt,
      })
      .onConflict((oc) => oc.column("transaction_key").doNothing())
      .execute();
  }
  return refundedSoFar(trx, opts.paymentId);
}

export async function refundedSoFar(
  executor: Executor,
  paymentId: string,
): Promise<{ refundedAmount: number; refundedAt: Date | null }> {
  const row = await executor
    .selectFrom("payment_transactions")
    .select([
      sql<number>`coalesce(sum(amount), 0)::int`.as("refunded"),
      sql<Date | null>`max(occurred_at)`.as("at"),
    ])
    .where("payment_id", "=", paymentId)
    .where("kind", "=", "cancel")
    .executeTakeFirstOrThrow();
  return {
    refundedAmount: row.refunded,
    refundedAt: row.at ? new Date(row.at) : null,
  };
}
