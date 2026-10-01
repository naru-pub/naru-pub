import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { labAccounts, LAB_TEST_CODES } from "@/lib/payments/billing-lab";
import { isTossTestMode } from "@/lib/payments/toss";
import { BillingLab } from "../_components/BillingLab";
import { requireOperator } from "../_components/requireOperator";

export const metadata: Metadata = { title: "결제 실험실 · 운영 · 나루" };

// Only with test keys: the lab charges and refunds for real.
export default async function BillingLabPage() {
  await requireOperator();
  if (!isTossTestMode()) notFound();
  return (
    <BillingLab accounts={await labAccounts()} testCodes={LAB_TEST_CODES} />
  );
}
