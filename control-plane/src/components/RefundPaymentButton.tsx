"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Undo2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";

// 환불은 되돌릴 수 없고 후원자 전용 기능이 즉시 닫히므로, 실행 전에 한 번
// 확인한다. 결제 내역(후원자)과 /admin(운영자)이 같은 엔드포인트를 쓰되 확인
// 문구만 달리 넘긴다.
export function RefundPaymentButton({
  paymentId,
  confirmMessage,
  label = "환불",
}: {
  paymentId: number;
  confirmMessage: string;
  label?: string;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);

  async function refund() {
    if (!confirm(confirmMessage)) return;
    setPending(true);
    try {
      const response = await fetch(
        `/api/account/payments/${paymentId}/refund`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        },
      );
      const body = await response.json();
      if (!response.ok || !body.success) {
        throw new Error(body.message ?? "환불 처리에 실패했습니다.");
      }
      toast.success(body.message ?? "환불이 접수되었습니다.");
      router.refresh();
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "환불 처리에 실패했습니다.",
      );
    } finally {
      setPending(false);
    }
  }

  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      disabled={pending}
      onClick={refund}
    >
      <Undo2 size={14} />
      {pending ? "환불 중..." : label}
    </Button>
  );
}
