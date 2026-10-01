import { redirect } from "next/navigation";
import { validateRequest } from "@/lib/auth";
import { PAYMENT_OPERATOR_USERS } from "@/lib/payments/support";

// Layouts are not re-run on client navigation, so each page checks too.
export async function requireOperator() {
  const { user } = await validateRequest();
  if (!user || !PAYMENT_OPERATOR_USERS.has(user.loginName)) {
    redirect("/account");
  }
  return user;
}
