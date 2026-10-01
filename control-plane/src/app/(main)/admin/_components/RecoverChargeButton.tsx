"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { LifeBuoy } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";

// For an order the ledger settled as expired, failed or declined: asks Toss
// whether it was paid after all, and if so grants it (recoverOrphanedCharge).
export function RecoverChargeButton({ paymentId }: { paymentId: string }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);

  async function recover() {
    if (
      !confirm(
        "Toss에서 이 주문이 결제 완료로 확인되면 기간을 부여합니다. 이용자에게 결제 완료 메일이 가고, 정기 결제라면 다음 결제일이 그만큼 미뤄지며 연체(past_due)였던 정기 결제는 다시 이어집니다. 이중 청구였다면 그 뒤 '환불 (정기 결제 유지)'로 돌려주세요. 계속할까요?",
      )
    ) {
      return;
    }
    setPending(true);
    try {
      const response = await fetch(`/api/admin/payments/${paymentId}/recover`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      const body = await response.json();
      if (!response.ok || !body.success) {
        throw new Error(body.message ?? "결제를 복구하지 못했습니다.");
      }
      if (body.result.state === "recovered") toast.success(body.message);
      else toast(body.message);
      router.refresh();
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "결제를 복구하지 못했습니다.",
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
      onClick={recover}
    >
      <LifeBuoy size={14} className={pending ? "animate-pulse" : ""} />
      Toss에서 복구
    </Button>
  );
}
