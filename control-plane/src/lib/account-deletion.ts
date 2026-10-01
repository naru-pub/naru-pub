import { retireBillingKey } from "@/lib/billing-keys";
import type { Executor } from "@/lib/entitlements";

// The only place a users row is deleted. Deleting it cascades to the
// subscription, which would take the billing key with it, so the key is
// retired first. The caller passes the returned key to deleteRetiredBillingKey
// once its transaction commits.
export async function deleteUserRow(
  trx: Executor,
  userId: string,
): Promise<string | null> {
  const billingKey = await retireBillingKey(trx, { userId });
  await trx.deleteFrom("users").where("id", "=", userId).execute();
  return billingKey;
}
