import { deleteRetiredBillingKeys } from "@/lib/payments/billing-keys";
import { retireAbandonedSignupKeys } from "@/lib/payments/payment-invariants";

async function main() {
  // Abandoned signups' keys join the queue first, so this run deletes them.
  const abandoned = await retireAbandonedSignupKeys();
  const { deleted, failed } = await deleteRetiredBillingKeys();
  console.log(
    `[delete-retired-billing-keys] abandoned signups ${abandoned}, deleted ${deleted}, failed ${failed}`,
  );
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("[delete-retired-billing-keys] fatal:", error);
    process.exit(1);
  });
