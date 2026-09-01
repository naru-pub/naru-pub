"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";

export function ReconcilePaymentButton({ paymentId }: { paymentId: number }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);

  async function reconcile() {
    setPending(true);
    try {
      const response = await fetch(
        `/api/account/payments/${paymentId}/reconcile`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        },
      );
      const body = await response.json();
      if (!response.ok || !body.success) {
        throw new Error(body.message ?? "결제 상태 확인에 실패했습니다.");
      }
      if (body.result.state === "pending") {
        toast("아직 Toss에서 결제 완료를 확인하지 못했습니다.");
      } else {
        toast.success("결제 상태를 다시 확인했습니다.");
      }
      router.refresh();
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : "결제 상태 확인에 실패했습니다.",
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
      onClick={reconcile}
    >
      <RefreshCw size={14} className={pending ? "animate-spin" : ""} />
      다시 확인
    </Button>
  );
}
