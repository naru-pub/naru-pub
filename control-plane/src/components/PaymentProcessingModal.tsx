"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { LoaderCircle } from "lucide-react";
import { Button } from "@/components/ui/button";

type State =
  | "processing"
  | "completed"
  | "scheduled"
  | "failed"
  | "needs_attention"
  | "unavailable";
export function PaymentProcessingModal({ paymentId }: { paymentId: string }) {
  const router = useRouter();
  const dialog = useRef<HTMLDialogElement>(null);
  const [closed, setClosed] = useState(false);
  const [state, setState] = useState<State>("processing");
  const [message, setMessage] = useState(
    "결제를 처리하고 있습니다. 잠시만 기다려 주세요.",
  );
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
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
    dialog.current?.close();
    router.replace("/supporter", { scroll: false });
  }
  return (
    <dialog
      ref={dialog}
      aria-labelledby="payment-processing-title"
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
      className="w-[calc(100%_-_2rem)] max-w-md border-2 border-line bg-card p-6 text-foreground backdrop:bg-black/50"
    >
      <h2 id="payment-processing-title" className="text-lg font-bold">
        {state === "processing"
          ? "결제 처리 중"
          : state === "completed"
            ? "결제 완료"
            : state === "scheduled"
              ? "정기 결제 예약 완료"
              : "결제 확인"}
      </h2>
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
    </dialog>
  );
}
