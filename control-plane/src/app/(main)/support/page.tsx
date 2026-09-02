import Link from "next/link";
import { redirect } from "next/navigation";
import { ReceiptText } from "lucide-react";

import { Button } from "@/components/ui/button";
import { validateRequest } from "@/lib/auth";
import { db } from "@/lib/database";
import { getUserEntitlement } from "@/lib/entitlements";
import { hasVerifiedEmail, SUPPORT_VISIBLE_USERS } from "@/lib/support";
import SupportCard from "../account/SupportCard";

export default async function SupportPage() {
  const { user } = await validateRequest();

  if (!user) {
    redirect("/");
  }

  if (!SUPPORT_VISIBLE_USERS.has(user.loginName)) {
    redirect("/account");
  }

  const entitlement = await getUserEntitlement(user.id);
  const subscriptionRow = await db
    .selectFrom("subscriptions")
    .select(["status", "billing_interval", "next_billing_at"])
    .where("user_id", "=", user.id)
    .executeTakeFirst();
  const subscription = subscriptionRow
    ? {
        status: subscriptionRow.status,
        billingInterval: subscriptionRow.billing_interval,
        nextBillingAt: subscriptionRow.next_billing_at
          ? new Date(subscriptionRow.next_billing_at).toISOString()
          : null,
      }
    : null;

  return (
    <div className="bg-background min-h-screen">
      <div className="max-w-4xl mx-auto p-6 space-y-4">
        <SupportCard
          clientKey={process.env.TOSS_CLIENT_KEY ?? ""}
          comp={entitlement.comp}
          supportActive={entitlement.paid}
          supporterUntil={
            entitlement.supporterUntil
              ? entitlement.supporterUntil.toISOString()
              : null
          }
          subscription={subscription}
          email={user.email}
          emailVerified={hasVerifiedEmail(user)}
        />
        <div className="flex justify-end">
          <Button asChild variant="outline">
            <Link href="/support/payments">
              <ReceiptText size={16} />
              결제 내역 보기
            </Link>
          </Button>
        </div>
      </div>
    </div>
  );
}
