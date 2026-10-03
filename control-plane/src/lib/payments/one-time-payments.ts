import { db } from "@/lib/database";
import { enqueueJob } from "@/lib/payments/payment-jobs";

// Callers hold the account lock. Persist the provider key and durable intent
// together; task params contain only the ledger identity, never browser amounts.
export async function enqueueOneTimeConfirmation(
  paymentId: string,
  paymentKey: string,
) {
  return db.transaction().execute(async (trx) => {
    const payment = await trx
      .selectFrom("payments")
      .selectAll()
      .where("id", "=", paymentId)
      .forUpdate()
      .executeTakeFirstOrThrow();
    if (payment.status !== "pending") return;
    if (
      payment.subscription_id ||
      !payment.attempt_key?.startsWith("one_time:")
    )
      throw new Error("Not a one-time payment");
    if (payment.toss_payment_key && payment.toss_payment_key !== paymentKey)
      throw new Error("One-time payment key mismatch");
    await trx
      .updateTable("payments")
      .set({ toss_payment_key: paymentKey })
      .where("id", "=", paymentId)
      .execute();
    return enqueueJob(
      trx,
      { kind: "confirm_one_time", paymentId },
      { dedupeKey: `one-time-confirm:${paymentId}` },
    );
  });
}
