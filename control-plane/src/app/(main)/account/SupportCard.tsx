"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { loadTossPayments } from "@tosspayments/tosspayments-sdk";
import { Heart, Send } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

// 카드사 심사는 서비스 제공기간이 1년을 넘는 상품을 허용하지 않으므로, 일회성
// 후원은 1년치 한 건만 판매한다. 서버(MAX_PURCHASABLE_ONE_TIME_YEARS)가 같은
// 한도를 강제한다. lib/toss는 crypto를 끌어오므로 여기서 import하지 않는다.
const ONE_TIME_YEARS = 1;
const ONE_TIME_AMOUNT = 12000;

type SubscriptionInfo = {
  status: string;
  billingInterval: string;
  nextBillingAt: string | null;
};

export default function SupportCard({
  clientKey,
  comp,
  supportActive,
  supporterUntil,
  subscription,
  email,
  emailVerified,
}: {
  clientKey: string;
  comp: boolean;
  supportActive: boolean;
  supporterUntil: string | null;
  subscription: SubscriptionInfo | null;
  email: string | null;
  emailVerified: boolean;
}) {
  const router = useRouter();
  const params = useSearchParams();
  const toasted = useRef(false);
  const [pending, setPending] = useState(false);
  const [resending, setResending] = useState(false);
  const untilLabel = supporterUntil
    ? new Date(supporterUntil).toLocaleDateString("ko-KR")
    : null;
  const isActive = subscription?.status === "active";
  const isScheduled = subscription?.status === "scheduled";
  const showRecurringOptions = !isActive && !isScheduled;
  const showOneTimeOptions =
    !isScheduled &&
    (!supportActive || isActive || subscription?.status === "canceled");
  const intervalLabel =
    subscription?.billingInterval === "year" ? "연간" : "월간";

  // Surface the result of the Toss redirect once, then clean the URL.
  useEffect(() => {
    if (toasted.current) return;
    const support = params.get("support");
    if (!support) return;
    toasted.current = true;
    if (support === "success") {
      toast.success(
        untilLabel
          ? `후원해 주셔서 감사합니다! ${untilLabel}까지 이용할 수 있습니다.`
          : "후원해 주셔서 감사합니다!",
      );
    } else if (support === "scheduled") {
      toast.success(
        untilLabel
          ? `${untilLabel}부터 정기 후원이 시작됩니다.`
          : "정기 후원이 예약되었습니다.",
      );
    } else if (support === "failed") toast.error("후원 처리에 실패했습니다.");
    else if (support === "canceled") toast("후원이 취소되었습니다.");
    router.replace("/support");
  }, [params, router, untilLabel]);

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
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ years: ONE_TIME_YEARS }),
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

  async function resendVerification() {
    setResending(true);
    try {
      const res = await fetch("/api/account/resend-verification-email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      const data = await res.json();
      if (res.ok && data.success) {
        toast.success(data.message ?? "인증 이메일을 다시 보냈습니다.");
      } else {
        toast.error(data.message ?? "인증 이메일을 보내지 못했습니다.");
      }
    } catch {
      toast.error("인증 이메일 발송 중 오류가 발생했습니다.");
    } finally {
      setResending(false);
    }
  }

  async function cancel() {
    if (
      !confirm(
        "후원을 취소하시겠어요? 남은 기간 동안은 계속 이용하실 수 있습니다.",
      )
    ) {
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

  return (
    <Card className="rounded-none bg-card border-2 border-border shadow-lg">
      <CardHeader className="bg-secondary border-b-2 border-border">
        <CardTitle className="text-foreground text-xl font-bold flex items-center gap-2">
          <Heart size={20} />
          나루 후원
          {comp && <Badge variant="secondary">평생 후원</Badge>}
          {!comp && (isActive || isScheduled || supportActive) && (
            <Badge variant="secondary">후원 중</Badge>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="p-6 space-y-4">
        <div className="text-sm text-muted-foreground space-y-2">
          <p>
            나루는 후원으로 굴러가는 작은 인디웹 서비스입니다. 후원해 주시면
            커스텀 도메인, 데이터베이스, 방문자 현황 기능을 쓰실 수 있습니다 🌱
          </p>
        </div>

        {comp ? (
          <div className="bg-green-500/5 border-2 border-green-500 p-3 text-sm text-green-700 dark:text-green-500">
            평생 후원자로 등록되어 있습니다. 나루를 아껴 주셔서 감사합니다. 🙏
          </div>
        ) : (
          <div className="space-y-4">
            {isActive ? (
              <div className="space-y-3">
                <div className="bg-muted border border-border p-3 text-sm">
                  {intervalLabel} 후원 중입니다. 감사합니다!
                  {subscription?.nextBillingAt && (
                    <>
                      {" "}
                      다음 결제일:{" "}
                      <strong className="text-foreground">
                        {new Date(
                          subscription.nextBillingAt,
                        ).toLocaleDateString("ko-KR")}
                      </strong>
                    </>
                  )}
                </div>
                <Button variant="outline" onClick={cancel} disabled={pending}>
                  후원 취소
                </Button>
              </div>
            ) : isScheduled && untilLabel ? (
              <div className="space-y-3">
                <div className="bg-muted border border-border p-3 text-sm text-muted-foreground">
                  현재 후원 기간은{" "}
                  <strong className="text-foreground">{untilLabel}</strong>까지
                  입니다. 이후 {intervalLabel} 정기 후원이 시작됩니다.
                </div>
                <Button variant="outline" onClick={cancel} disabled={pending}>
                  정기 후원 예약 취소
                </Button>
              </div>
            ) : subscription?.status === "canceled" &&
              supportActive &&
              untilLabel ? (
              <div className="bg-muted border border-border p-3 text-sm text-muted-foreground">
                정기 후원이 종료되었습니다.{" "}
                <strong className="text-foreground">{untilLabel}</strong>까지
                후원자 기능을 이용하실 수 있습니다.
              </div>
            ) : supportActive && untilLabel ? (
              <div className="bg-muted border border-border p-3 text-sm text-muted-foreground">
                일회성 후원 이용 중입니다.{" "}
                <strong className="text-foreground">{untilLabel}</strong>까지
                후원자 기능을 이용하실 수 있습니다.
              </div>
            ) : null}

            {!emailVerified && (
              <div className="space-y-3 border-2 border-yellow-500 bg-yellow-500/5 p-3 text-sm">
                <p className="text-yellow-800 dark:text-yellow-300">
                  {email
                    ? `후원 영수증과 결제 안내를 보내드려야 하므로, 후원을 시작하려면 먼저 이메일 인증이 필요합니다. ${email} 주소로 보낸 인증 메일을 확인해 주세요.`
                    : "후원 영수증과 결제 안내를 보내드려야 하므로, 후원을 시작하려면 인증된 이메일 주소가 필요합니다. 계정 관리에서 이메일을 등록해 주세요."}
                </p>
                <div className="flex flex-col gap-2 sm:flex-row">
                  {email && (
                    <Button
                      variant="outline"
                      onClick={resendVerification}
                      disabled={resending}
                    >
                      <Send size={16} />
                      {resending ? "발송 중..." : "인증 이메일 재발송"}
                    </Button>
                  )}
                  <Button asChild variant="outline">
                    <Link href="/account">계정 관리로 이동</Link>
                  </Button>
                </div>
              </div>
            )}

            {emailVerified && (showRecurringOptions || showOneTimeOptions) && (
              <div className="space-y-2">
                {showRecurringOptions && (
                  <>
                    <p className="text-xs text-muted-foreground">정기 후원</p>
                    <div className="flex flex-col sm:flex-row gap-2">
                      <Button
                        onClick={() => subscribe("month")}
                        disabled={pending}
                        className="flex-1"
                      >
                        {supportActive
                          ? "기간 종료 후 월 1,000원"
                          : "월 1,000원 후원"}
                      </Button>
                      <Button
                        onClick={() => subscribe("year")}
                        disabled={pending}
                        className="flex-1"
                      >
                        {supportActive
                          ? "기간 종료 후 연 10,000원"
                          : "연 10,000원 후원 (2개월 무료)"}
                      </Button>
                    </div>
                  </>
                )}
                {showOneTimeOptions && (
                  <>
                    <p className="text-xs text-muted-foreground pt-1">
                      {supportActive ? "일회성 후원으로 전환" : "한 번만 후원"}
                    </p>
                    <div className="flex flex-col gap-2 sm:flex-row">
                      <Button
                        onClick={donateOnce}
                        disabled={pending}
                        variant="outline"
                        className="flex-1"
                      >
                        {ONE_TIME_AMOUNT.toLocaleString("ko-KR")}원 결제 (1년,
                        자동 갱신 없음)
                      </Button>
                    </div>
                  </>
                )}
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
