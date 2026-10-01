import { retireBillingKey } from "@/lib/billing-keys";
import { db } from "@/lib/database";
import type { Executor } from "@/lib/entitlements";
import { reconcilePayment } from "@/lib/payment-reconciliation";
import { CHARGE_LEASE_MINUTES } from "@/lib/subscriptions";

export const CHARGE_IN_FLIGHT_MESSAGE =
  "결제 결과를 확인하고 있어 지금은 계정을 삭제할 수 없습니다. 잠시 후 다시 시도해 주세요.";

// An account must not be deleted under a charge: the payment row, the
// subscription and the user cascade away, so a card Toss charges a moment
// later leaves no row, no event and no account to refund.
export class ChargeInFlightError extends Error {
  constructor(userId: string) {
    super(`User ${userId} has a subscription charge in flight`);
    this.name = "ChargeInFlightError";
  }
}

function leaseLive(chargingStartedAt: Date | string | null, now = new Date()) {
  return (
    chargingStartedAt != null &&
    new Date(chargingStartedAt).getTime() >
      now.getTime() - CHARGE_LEASE_MINUTES * 60 * 1000
  );
}

// Run before anything of the account is deleted, so a refusal leaves it
// whole. Settles the subscription's charges whose outcome is unknown, then
// says whether the account can go: no charge holding the lease, and none
// still pending. One-time orders do not block — one the buyer authenticated
// is never approved once its row is gone, and Toss lets it lapse.
export async function settleChargesBeforeDeletion(
  userId: string,
): Promise<boolean> {
  const pending = await db
    .selectFrom("payments")
    .select("id")
    .where("user_id", "=", userId)
    .where("subscription_id", "is not", null)
    .where("status", "=", "pending")
    .execute();
  for (const payment of pending) {
    await reconcilePayment(payment.id).catch((error) =>
      console.error(
        `Account deletion: reconciling payment ${payment.id} failed`,
        error,
      ),
    );
  }
  const subscription = await db
    .selectFrom("subscriptions")
    .select("charging_started_at")
    .where("user_id", "=", userId)
    .executeTakeFirst();
  if (leaseLive(subscription?.charging_started_at ?? null)) return false;
  const left = await db
    .selectFrom("payments")
    .select("id")
    .where("user_id", "=", userId)
    .where("subscription_id", "is not", null)
    .where("status", "=", "pending")
    .executeTakeFirst();
  return left == null;
}

// The only place a users row is deleted. Deleting it cascades to the
// subscription, which would take the billing key with it, so the key is
// retired first. The caller passes the returned key to deleteRetiredBillingKey
// once its transaction commits.
//
// Locks in the order a grant takes them — the account's payments, the user,
// then the subscription — so the two cannot deadlock, and checks once more
// under those locks that no charge holds the lease (ChargeInFlightError).
export async function deleteUserRow(
  trx: Executor,
  userId: string,
): Promise<string | null> {
  await trx
    .selectFrom("payments")
    .select("id")
    .where("user_id", "=", userId)
    .forUpdate()
    .execute();
  await trx
    .selectFrom("users")
    .select("id")
    .where("id", "=", userId)
    .forUpdate()
    .execute();
  const subscription = await trx
    .selectFrom("subscriptions")
    .select("charging_started_at")
    .where("user_id", "=", userId)
    .forUpdate()
    .executeTakeFirst();
  if (leaseLive(subscription?.charging_started_at ?? null)) {
    throw new ChargeInFlightError(userId);
  }
  const billingKey = await retireBillingKey(trx, { userId });
  await trx.deleteFrom("users").where("id", "=", userId).execute();
  return billingKey;
}
