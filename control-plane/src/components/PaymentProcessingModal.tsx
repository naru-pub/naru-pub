"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { LoaderCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";

type State =
  | "processing"
  | "completed"
  | "scheduled"
  | "failed"
  | "needs_attention"
  | "unavailable";
export function PaymentProcessingModal({ paymentId }: { paymentId: string }) {
  const router = useRouter();
  const [closed, setClosed] = useState(false);
  const [state, setState] = useState<State>("processing");
  const [message, setMessage] = useState(
    "결제를 처리하고 있습니다. 잠시만 기다려 주세요.",
  );
  useEffect(() => {
    if (closed) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const controller = new AbortController();
    async function poll() {
      try {
        const response = await fetch(`/api/account/payments/${paymentId}`, {
          cache: "no-store",
          signal: controller.signal,
        });
        const body = await response.json();
        if (cancelled) return;
        if ([401, 404].includes(response.status)) {
          setState("unavailable");
          setMessage(body.message);
          return;
        }
        if (response.ok && body.success) {
          setMessage(body.message);
          if (
            ["completed", "scheduled", "failed", "needs_attention"].includes(
              body.state,
            )
          ) {
            setState(body.state);
            router.refresh();
            return;
          }
        }
      } catch {
        if (!cancelled)
          setMessage("연결을 확인하고 있습니다. 결제 상태를 다시 확인할게요.");
      }
      if (!cancelled) timer = setTimeout(poll, 2000);
    }
    void poll();
    return () => {
      cancelled = true;
      controller.abort();
      clearTimeout(timer);
    };
  }, [closed, paymentId, router]);
  function close() {
    setClosed(true);
    router.replace("/supporter", { scroll: false });
  }
  return (
    <Dialog
      open={!closed}
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      {/* Esc closes it; a stray click outside does not, so the result of a
          payment is never dismissed by accident. */}
      <DialogContent
        hideClose
        className="max-w-md gap-0"
        onInteractOutside={(event) => event.preventDefault()}
      >
        <DialogTitle>
          {state === "processing"
            ? "결제 처리 중"
            : state === "completed"
              ? "결제 완료"
              : state === "scheduled"
                ? "정기 결제 예약 완료"
                : "결제 확인"}
        </DialogTitle>
        <DialogDescription className="sr-only">결제 상태</DialogDescription>
        <div
          className="my-6 flex items-center gap-3"
          role="status"
          aria-live="polite"
        >
          {state === "processing" && (
            <LoaderCircle
              className="shrink-0 animate-spin"
              aria-hidden="true"
              size={24}
            />
          )}
          <p>{message}</p>
        </div>
        {state === "processing" && (
          <p className="mb-4 text-sm text-muted-foreground">
            창을 닫아도 결제는 계속 처리됩니다.
          </p>
        )}
        <Button
          onClick={close}
          variant={state === "processing" ? "outline" : "default"}
        >
          {state === "processing" ? "닫기" : "확인"}
        </Button>
      </DialogContent>
    </Dialog>
  );
}
