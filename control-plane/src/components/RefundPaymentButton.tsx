"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Undo2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";

// 환불이 완료되면 유료 기능이 닫히므로, 신청 전에 한 번
// 확인한다. 결제 내역(유료 이용자)과 /admin(운영자)이 같은 엔드포인트를 쓰되 확인
// 문구만 달리 넘긴다.
export function RefundPaymentButton({
  paymentId,
  confirmMessage,
  label = "환불",
  requested = false,
}: {
  paymentId: string;
  confirmMessage: string;
  label?: string;
  requested?: boolean;
}) {
  const router = useRouter();
  const [sending, setSending] = useState(false);
  const [state, setState] = useState<
    "idle" | "pending" | "completed" | "failed"
  >(requested ? "pending" : "idle");
  const pending = state === "pending" || (requested && state === "idle");
  useEffect(() => {
    if (!pending) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const response = await fetch(
          `/api/account/payments/${paymentId}/refund`,
          { cache: "no-store" },
        );
        const body = await response.json();
        if (cancelled) return;
        if (
          response.ok &&
          body.success &&
          ["completed", "failed"].includes(body.result.state)
        ) {
          setState(body.result.state);
          if (body.result.state === "completed") {
            toast.success("환불이 완료되었습니다.");
            router.refresh();
          }
          return;
        }
      } catch {
        /* A connection failure does not change the durable request. */
      }
      if (!cancelled) timer = setTimeout(poll, 5000);
    }
    void poll();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [pending, paymentId, router]);

  async function refund() {
    if (!confirm(confirmMessage)) return;
    setSending(true);
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
      setState(body.result.state);
      if (body.result.state === "failed") toast.error(body.message);
      else toast.success(body.message ?? "환불 신청을 접수했습니다.");
      router.refresh();
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "환불 처리에 실패했습니다.",
      );
    } finally {
      setSending(false);
    }
  }

  if (state === "completed")
    return <span className="text-xs text-muted-foreground">환불 완료</span>;
  if (state === "failed")
    return (
      <span className="text-xs text-destructive" role="status">
        환불 처리 확인 필요 · 운영자에게 문의해 주세요
      </span>
    );

  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      disabled={sending || pending}
      onClick={refund}
    >
      <Undo2 size={14} />
      {sending ? "접수 중..." : pending ? "환불 처리 중" : label}
    </Button>
  );
}
