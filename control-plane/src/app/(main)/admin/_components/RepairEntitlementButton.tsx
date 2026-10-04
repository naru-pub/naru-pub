"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";

export function RepairEntitlementButton({ userId }: { userId: string }) {
  const [pending, setPending] = useState(false);
  const router = useRouter();
  async function retry() {
    const reason = window.prompt(
      "이용 기한을 복구하는 사유를 입력해 주세요 (200자 이내).",
    );
    if (!reason?.trim()) return;
    setPending(true);
    try {
      const response = await fetch(`/api/admin/entitlements/${userId}/repair`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason }),
      });
      const body = await response.json();
      if (!response.ok || !body.success)
        throw new Error(body.message ?? "복구 요청 실패");
      toast.success("이용 기한 복구를 접수했습니다.");
      router.refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "복구 요청 실패");
    } finally {
      setPending(false);
    }
  }
  return (
    <Button size="sm" variant="outline" disabled={pending} onClick={retry}>
      {pending ? "접수 중…" : "이용 기한 복구"}
    </Button>
  );
}
