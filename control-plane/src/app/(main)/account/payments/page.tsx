import { redirect } from "next/navigation";

export default function AccountPaymentsRedirect() {
  redirect("/supporter/payments");
}
