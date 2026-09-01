"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { loadTossPayments } from "@tosspayments/tosspayments-sdk";
import { Heart } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

type SubscriptionInfo = {
  status: string;
  billingInterval: string;
  nextBillingAt: string | null;
};

export default function SupportCard({
  clientKey,
  comp,
  supporterUntil,
  subscription,
}: {
  clientKey: string;
  comp: boolean;
  supporterUntil: string | null;
  subscription: SubscriptionInfo | null;
}) {
  const router = useRouter();
  const params = useSearchParams();
  const toasted = useRef(false);
  const [pending, setPending] = useState(false);

  // Surface the result of the Toss redirect once, then clean the URL.
  useEffect(() => {
    if (toasted.current) return;
    const support = params.get("support");
    if (!support) return;
    toasted.current = true;
    if (support === "success") toast.success("후원해 주셔서 감사합니다!");
    else if (support === "failed") toast.error("후원 처리에 실패했습니다.");
    else if (support === "canceled") toast("후원이 취소되었습니다.");
    router.replace("/account");
  }, [params, router]);

  async function subscribe(interval: "month" | "year") {
    setPending(true);
    try {
      const res = await fetch("/api/account/subscription/prepare", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ interval }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        toast.error(data.message ?? "후원을 시작할 수 없습니다.");
        setPending(false);
        return;
      }

      if (!clientKey) {
        toast.error("결제 설정이 올바르지 않습니다.");
        setPending(false);
        return;
      }

      const tossPayments = await loadTossPayments(clientKey);
      const payment = tossPayments.payment({ customerKey: data.customerKey });
      await payment.requestBillingAuth({
        method: "CARD",
        successUrl: `${window.location.origin}/account/subscription/callback`,
        failUrl: `${window.location.origin}/account?support=canceled`,
      });
      // requestBillingAuth redirects the browser; control resumes on the callback page.
    } catch {
      toast.error("결제 창을 여는 중 오류가 발생했습니다.");
      setPending(false);
    }
  }

  async function donateOnce() {
    setPending(true);
    try {
      const res = await fetch("/api/account/donation/one-time/prepare", {
        method: "POST",
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        toast.error(data.message ?? "후원을 시작할 수 없습니다.");
        setPending(false);
        return;
      }

      if (!clientKey) {
        toast.error("결제 설정이 올바르지 않습니다.");
        setPending(false);
        return;
      }

      const tossPayments = await loadTossPayments(clientKey);
      const payment = tossPayments.payment({ customerKey: data.customerKey });
      await payment.requestPayment({
        method: "CARD",
        amount: { currency: "KRW", value: data.amount },
        orderId: data.orderId,
        orderName: data.orderName,
        successUrl: `${window.location.origin}/account/donation/callback`,
        failUrl: `${window.location.origin}/account?support=canceled`,
      });
      // requestPayment redirects the browser; control resumes on the callback page.
    } catch {
      toast.error("결제 창을 여는 중 오류가 발생했습니다.");
      setPending(false);
    }
  }

  async function cancel() {
    if (!confirm("후원을 취소하시겠어요? 남은 기간 동안은 계속 이용하실 수 있습니다.")) {
      return;
    }
    setPending(true);
    try {
      const res = await fetch("/api/account/subscription/cancel", {
        method: "POST",
      });
      const data = await res.json();
      if (res.ok && data.success) {
        toast.success(data.message ?? "후원이 취소되었습니다.");
        router.refresh();
      } else {
        toast.error(data.message ?? "후원 취소에 실패했습니다.");
      }
    } catch {
      toast.error("후원 취소 중 오류가 발생했습니다.");
    } finally {
      setPending(false);
    }
  }

  const untilLabel = supporterUntil
    ? new Date(supporterUntil).toLocaleDateString("ko-KR")
    : null;
  const isActive = subscription?.status === "active";
  const intervalLabel =
    subscription?.billingInterval === "year" ? "연간" : "월간";

  return (
    <Card className="bg-card border-2 border-border shadow-lg">
      <CardHeader className="bg-secondary border-b-2 border-border">
        <CardTitle className="text-foreground text-xl font-bold flex items-center gap-2">
          <Heart size={20} />
          나루 후원
          {comp && <Badge variant="secondary">평생 후원</Badge>}
          {isActive && <Badge variant="secondary">후원 중</Badge>}
        </CardTitle>
      </CardHeader>
      <CardContent className="p-6 space-y-4">
        <div className="text-sm text-muted-foreground space-y-2">
          <p>
            나루는 후원으로 굴러가는 작은 인디웹 서비스입니다. 후원해 주시면
            커스텀 도메인, 데이터베이스, 방문자 현황 기능을 쓰실 수 있습니다
            🌱
          </p>
        </div>

        {comp ? (
          <div className="bg-green-500/5 border-2 border-green-500 rounded p-3 text-sm text-green-700 dark:text-green-500">
            평생 후원자로 등록되어 있습니다. 나루를 아껴 주셔서 감사합니다. 🙏
          </div>
        ) : isActive ? (
          <div className="space-y-3">
            <div className="bg-muted border border-border rounded p-3 text-sm">
              {intervalLabel} 후원 중입니다. 감사합니다!
              {subscription?.nextBillingAt && (
                <>
                  {" "}
                  다음 결제일:{" "}
                  <strong className="text-foreground">
                    {new Date(subscription.nextBillingAt).toLocaleDateString(
                      "ko-KR"
                    )}
                  </strong>
                </>
              )}
            </div>
            <Button variant="outline" onClick={cancel} disabled={pending}>
              후원 취소
            </Button>
          </div>
        ) : (
          <div className="space-y-3">
            {untilLabel && (
              <div className="bg-muted border border-border rounded p-3 text-sm text-muted-foreground">
                후원이 종료될 예정입니다.{" "}
                <strong className="text-foreground">{untilLabel}</strong>까지
                후원자 기능을 이용하실 수 있습니다.
              </div>
            )}
            <div className="space-y-2">
              <p className="text-xs text-muted-foreground">정기 후원</p>
              <div className="flex flex-col sm:flex-row gap-2">
                <Button
                  onClick={() => subscribe("month")}
                  disabled={pending}
                  className="flex-1"
                >
                  월 1,000원 후원
                </Button>
                <Button
                  onClick={() => subscribe("year")}
                  disabled={pending}
                  className="flex-1"
                >
                  연 10,000원 후원 (2개월 무료)
                </Button>
              </div>
              <p className="text-xs text-muted-foreground pt-1">한 번만 후원</p>
              <Button
                onClick={donateOnce}
                disabled={pending}
                variant="outline"
                className="w-full"
              >
                1년 12,000원 (한 번만 결제, 자동 갱신 없음)
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
