"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

function Callback() {
  const router = useRouter();
  const params = useSearchParams();
  const ran = useRef(false);
  const [message, setMessage] = useState("후원을 처리하고 있습니다…");

  useEffect(() => {
    if (ran.current) return;
    ran.current = true;

    const paymentKey = params.get("paymentKey");
    const orderId = params.get("orderId");
    const amount = params.get("amount");

    // Toss omits these on cancel/failure.
    if (!paymentKey || !orderId || !amount) {
      router.replace("/support?support=canceled");
      return;
    }

    (async () => {
      try {
        for (let attempt = 0; attempt < 5; attempt += 1) {
          const res = await fetch("/api/account/donation/one-time/confirm", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              paymentKey,
              orderId,
              amount: Number(amount),
            }),
          });
          const data = await res.json();
          if (res.ok && data.success) {
            router.replace("/support?support=success");
            return;
          }
          if (res.status !== 503) {
            const query = new URLSearchParams({ support: "failed" });
            if (data.message) query.set("message", data.message);
            router.replace(`/support?${query}`);
            return;
          }
          setMessage(data.message);
          await new Promise((resolve) => setTimeout(resolve, 2000));
        }
        setMessage(
          "결제 확인이 지연되고 있습니다. 잠시 후 이 페이지를 새로고침해 주세요.",
        );
      } catch {
        setMessage(
          "결제 확인이 지연되고 있습니다. 잠시 후 이 페이지를 새로고침해 주세요.",
        );
      }
    })();
  }, [params, router]);

  return (
    <div className="max-w-xl mx-auto p-8 text-center text-muted-foreground">
      {message}
    </div>
  );
}

export default function DonationCallbackPage() {
  return (
    <Suspense
      fallback={
        <div className="max-w-xl mx-auto p-8 text-center text-muted-foreground">
          후원을 처리하고 있습니다…
        </div>
      }
    >
      <Callback />
    </Suspense>
  );
}
