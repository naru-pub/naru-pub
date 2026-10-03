"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";

export function RetryPaymentTaskButton({ taskId }: { taskId: string }) {
  const [pending, setPending] = useState(false);
  const router = useRouter();
  async function retry() {
    const reason = window.prompt(
      "작업을 다시 시도하는 사유를 입력해 주세요 (200자 이내).",
    );
    if (!reason?.trim()) return;
    setPending(true);
    try {
      const response = await fetch(`/api/admin/payment-tasks/${taskId}/retry`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason }),
      });
      const body = await response.json();
      if (!response.ok || !body.success)
        throw new Error(body.message ?? "재시도 요청 실패");
      toast.success("작업 재시도를 접수했습니다.");
      router.refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "재시도 요청 실패");
    } finally {
      setPending(false);
    }
  }
  return (
    <Button size="sm" variant="outline" disabled={pending} onClick={retry}>
      {pending ? "접수 중…" : "작업 재시도"}
    </Button>
  );
}
