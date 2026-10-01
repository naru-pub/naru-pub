import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { validateRequest } from "@/lib/auth";
import { PAYMENT_OPERATOR_USERS } from "@/lib/support";
import { isTossTestMode } from "@/lib/toss";
import { AdminNav } from "./_components/AdminNav";

export const metadata: Metadata = { title: "운영 · 나루" };

// Every /admin page is for operators only; the pages check again on their
// own, since a layout does not re-run on every navigation.
export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { user } = await validateRequest();
  if (!user || !PAYMENT_OPERATOR_USERS.has(user.loginName)) {
    redirect("/account");
  }

  const sections = [
    { href: "/admin", label: "개요" },
    { href: "/admin/payments", label: "결제" },
    { href: "/admin/subscriptions", label: "정기 결제" },
    { href: "/admin/supporters", label: "유료 이용자" },
    { href: "/admin/events", label: "결제 이벤트" },
    { href: "/admin/webhooks", label: "웹훅" },
    { href: "/admin/toss-calls", label: "Toss 호출" },
    { href: "/admin/billing-keys", label: "빌링키 삭제" },
    // The lab charges and refunds for real, so it exists only with test keys.
    ...(isTossTestMode() ? [{ href: "/admin/lab", label: "결제 실험실" }] : []),
    { href: "/admin/board", label: "게시판" },
  ];

  return (
    <div className="min-h-screen bg-background">
      <div className="mx-auto max-w-7xl space-y-6 p-4 sm:p-6">
        <div className="space-y-3">
          <h1 className="text-2xl font-bold">운영</h1>
          <AdminNav sections={sections} />
        </div>
        {children}
      </div>
    </div>
  );
}
