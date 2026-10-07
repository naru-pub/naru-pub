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
import { renewalChargeAt } from "@/lib/payments/renewal-time";

// 카드사 심사는 서비스 제공기간이 1년을 넘는 상품을 허용하지 않으므로, 일회성
// 일회성 결제는 1년치 한 건만 판매한다. 서버(MAX_PURCHASABLE_ONE_TIME_YEARS)가 같은
// 한도를 강제한다. lib/toss는 crypto를 끌어오므로 여기서 import하지 않는다.
const ONE_TIME_YEARS = 1;
const ONE_TIME_AMOUNT = 12000;

// Toss reports a closed payment window through failUrl with the same shape as a
// real failure. These two codes mean the supporter backed out, so they get the
// neutral notice rather than an error.
const USER_CANCELED_CODES = new Set(["PAY_PROCESS_CANCELED", "USER_CANCEL"]);
// Not "결제가 취소되었습니다": that is what a refund is called, and closing a
// window charges nothing.
const WINDOW_CLOSED_MESSAGE = "결제창을 닫았습니다. 청구된 금액은 없습니다.";

// Where the window is a popup (desktop), the SDK does not redirect to failUrl
// but rejects requestPayment/requestBillingAuth with the same { code, message }.
// The day a renewal is charged (09:00 KST on or after it falls due), as a
// Korean date.
function formatChargeDate(nextBillingAt: string | Date) {
  return renewalChargeAt(nextBillingAt).toLocaleDateString("ko-KR", {
    timeZone: "Asia/Seoul",
  });
}

function RenewalRetryNotice() {
  return (
    <div className="border-2 border-yellow-500 bg-yellow-500/5 p-3 text-sm text-yellow-800 dark:text-yellow-300">
      정기 결제가 아직 완료되지 않아 매일 오전 9시에 다시 시도하고 있습니다.
      카드에 문제가 있다면 카드를 변경해 주세요.
    </div>
  );
}

type TossWindow =
  | { window: "billing_auth"; registrationId: string }
  | { window: "payment"; orderId: string };

// Keeps how a Toss window ended when it did not succeed
// (api/account/payment-window): nothing else ever sees Toss's code for it.
// Best effort; the supporter is told either way.
function reportWindowOutcome(
  tossWindow: TossWindow,
  code: string,
  message: string | null,
) {
  void fetch("/api/account/payment-window", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...tossWindow, code, message }),
    keepalive: true,
  }).catch(() => {});
}

function paymentWindowError(error: unknown, tossWindow: TossWindow | null) {
  const { code, message } = (error ?? {}) as {
    code?: unknown;
    message?: unknown;
  };
  if (tossWindow && typeof code === "string") {
    reportWindowOutcome(
      tossWindow,
      code,
      typeof message === "string" ? message : null,
    );
  }
  if (typeof code === "string" && USER_CANCELED_CODES.has(code)) {
    toast(WINDOW_CLOSED_MESSAGE);
  } else if (typeof code === "string" && typeof message === "string") {
    toast.error(message);
  } else {
    toast.error("결제 창을 여는 중 오류가 발생했습니다.");
  }
}

type SubscriptionInfo = {
  status: string;
  billingInterval: string;
  nextBillingAt: string | null;
};

export default function SupportCard({
  billingClientKey,
  paymentClientKey,
  comp,
  supportActive,
  supporterUntil,
  subscription,
  email,
  emailVerified,
}: {
  billingClientKey: string;
  paymentClientKey: string;
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
  const isPastDue = subscription?.status === "past_due";
  // A plan that still holds a card and could charge (or be revived to).
  const planCanCharge = isActive || isScheduled || isPastDue;
  // A renewal (or a scheduled first charge) whose day has passed is being
  // retried: show that, not a healthy plan with a next date in the past.
  const renewalOverdue =
    (isActive || isScheduled) &&
    subscription?.nextBillingAt != null &&
    renewalChargeAt(subscription.nextBillingAt).getTime() <= Date.now();
  const showRecurringOptions = !isActive && !isScheduled;
  // Not beside a plan that charges or may (lib/payments/support-purchases): the
  // supporter cancels it first.
  const showOneTimeOptions =
    !planCanCharge && (!supportActive || subscription?.status === "canceled");
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
          ? `결제해 주셔서 감사합니다! ${untilLabel}까지 이용할 수 있습니다.`
          : "결제해 주셔서 감사합니다!",
      );
    } else if (support === "scheduled") {
      toast.success(
        untilLabel
          ? `${untilLabel}부터 정기 결제가 시작됩니다.`
          : "정기 결제가 예약되었습니다.",
      );
    } else if (support === "failed") {
      // Toss appends code and message to failUrl; the confirm callbacks pass
      // their own message the same way. Show what actually went wrong -- a
      // rejected card number is something the supporter can act on.
      const code = params.get("code");
      const message = params.get("message");
      // The failUrl names the window; Toss adds code and message.
      const registrationId = params.get("registration");
      const orderId = params.get("orderId") ?? params.get("order");
      if (code && registrationId) {
        reportWindowOutcome(
          { window: "billing_auth", registrationId },
          code,
          message,
        );
      } else if (code && orderId) {
        reportWindowOutcome({ window: "payment", orderId }, code, message);
      }
      if (code && USER_CANCELED_CODES.has(code)) {
        toast(WINDOW_CLOSED_MESSAGE);
      } else {
        toast.error(message || "결제 처리에 실패했습니다.");
      }
    } else if (support === "card-changed") {
      toast.success("결제 카드를 변경했습니다.");
    } else if (support === "card-changed-pending") {
      toast.success(
        "결제 카드를 변경했습니다. 밀린 정기 결제를 처리 중이며 결과는 결제 내역에서 확인할 수 있습니다.",
      );
    } else if (support === "canceled") toast(WINDOW_CLOSED_MESSAGE);
    router.replace("/supporter");
  }, [params, router, untilLabel]);

  // Registers a card with Toss: prepare (a signup, or a card change) hands
  // back the customerKey and the registration id the callback path carries.
  async function registerCard(
    prepareUrl: string,
    body: unknown,
    failMessage: string,
  ) {
    setPending(true);
    let tossWindow: TossWindow | null = null;
    try {
      const res = await fetch(prepareUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        toast.error(data.message ?? failMessage);
        setPending(false);
        return;
      }
      tossWindow = {
        window: "billing_auth",
        registrationId: data.registrationId,
      };

      if (!billingClientKey) {
        toast.error("결제 설정이 올바르지 않습니다.");
        setPending(false);
        return;
      }

      const tossPayments = await loadTossPayments(billingClientKey);
      const payment = tossPayments.payment({ customerKey: data.customerKey });
      await payment.requestBillingAuth({
        method: "CARD",
        successUrl: `${window.location.origin}/account/subscription/callback/${data.registrationId}`,
        failUrl: `${window.location.origin}/supporter?support=failed&registration=${data.registrationId}`,
      });
      // requestBillingAuth redirects the browser; control resumes on the callback page.
    } catch (error) {
      paymentWindowError(error, tossWindow);
      setPending(false);
    }
  }

  function subscribe(interval: "month" | "year") {
    return registerCard(
      "/api/account/subscription/prepare",
      { interval },
      "결제를 시작할 수 없습니다.",
    );
  }

  function changeCard() {
    return registerCard(
      "/api/account/subscription/card/prepare",
      {},
      "카드를 변경할 수 없습니다.",
    );
  }

  async function donateOnce() {
    setPending(true);
    let tossWindow: TossWindow | null = null;
    try {
      const res = await fetch("/api/account/donation/one-time/prepare", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ years: ONE_TIME_YEARS }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        toast.error(data.message ?? "결제를 시작할 수 없습니다.");
        setPending(false);
        return;
      }
      tossWindow = { window: "payment", orderId: data.orderId };

      if (!paymentClientKey) {
        toast.error("결제 설정이 올바르지 않습니다.");
        setPending(false);
        return;
      }

      const tossPayments = await loadTossPayments(paymentClientKey);
      const payment = tossPayments.payment({ customerKey: data.customerKey });
      await payment.requestPayment({
        method: "CARD",
        amount: { currency: "KRW", value: data.amount },
        orderId: data.orderId,
        orderName: data.orderName,
        successUrl: `${window.location.origin}/account/donation/callback`,
        failUrl: `${window.location.origin}/supporter?support=failed&order=${encodeURIComponent(data.orderId)}`,
      });
      // requestPayment redirects the browser; control resumes on the callback page.
    } catch (error) {
      paymentWindowError(error, tossWindow);
      setPending(false);
    }
  }

  async function resendVerification() {
    setResending(true);
    try {
      const res = await fetch("/api/account/resend-verification-email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // The mail's link brings the supporter back here once verified.
        body: JSON.stringify({ next: "/supporter" }),
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
        "정기 결제를 해지하시겠어요? 더 이상 자동으로 결제되지 않으며, 결제한 기간 동안은 계속 이용하실 수 있습니다. 환불은 결제 내역에서 따로 신청합니다.",
      )
    ) {
      return;
    }
    setPending(true);
    try {
      const res = await fetch("/api/account/subscription/cancel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      const data = await res.json();
      if (res.ok && data.success) {
        toast.success(data.message ?? "정기 결제를 해지했습니다.");
        router.refresh();
      } else {
        toast.error(data.message ?? "정기 결제를 해지하지 못했습니다.");
      }
    } catch {
      toast.error("정기 결제 해지 중 오류가 발생했습니다.");
    } finally {
      setPending(false);
    }
  }

  return (
    <Card className="rounded-none bg-card border-2 border-border shadow-lg">
      <CardHeader className="bg-secondary border-b-2 border-border">
        <CardTitle className="text-foreground text-xl font-bold flex items-center gap-2">
          <Heart size={20} />
          나루 유료 서비스
          {comp && <Badge variant="secondary">평생 이용</Badge>}
          {!comp && (isActive || isScheduled || supportActive) && (
            <Badge variant="secondary">결제 중</Badge>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="p-6 space-y-4">
        <div className="text-sm text-muted-foreground space-y-2">
          <p>
            나루는 유료 서비스로 운영되는 작은 인디웹 서비스입니다. 결제하시면
            아래 유료 기능을 쓰실 수 있습니다 🌱
          </p>
        </div>

        {comp ? (
          <div className="space-y-3">
            <div className="bg-green-500/5 border-2 border-green-500 p-3 text-sm text-green-700 dark:text-green-500">
              평생 이용 권한으로 등록되어 있습니다. 나루를 아껴 주셔서
              감사합니다. 🙏
            </div>
            {/* A plan from before the comp is no longer charged, but its card
                is still registered: let the supporter remove it. */}
            {planCanCharge && (
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                <p className="text-sm text-muted-foreground">
                  평생 이용 중에는 정기 결제가 청구되지 않습니다. 등록된 카드를
                  지우려면 정기 결제를 해지하세요.
                </p>
                <Button variant="outline" onClick={cancel} disabled={pending}>
                  정기 결제 해지
                </Button>
              </div>
            )}
          </div>
        ) : (
          <div className="space-y-4">
            {isActive ? (
              <div className="space-y-3">
                <div className="bg-muted border border-border p-3 text-sm">
                  {intervalLabel} 정기 결제를 이용 중입니다. 감사합니다!
                  {subscription?.nextBillingAt && !renewalOverdue && (
                    <>
                      {" "}
                      다음 결제일:{" "}
                      <strong className="text-foreground">
                        {formatChargeDate(subscription.nextBillingAt)}
                      </strong>{" "}
                      오전 9시
                    </>
                  )}
                </div>
                {renewalOverdue && <RenewalRetryNotice />}
                <div className="flex flex-col gap-2 sm:flex-row">
                  <Button
                    variant="outline"
                    onClick={changeCard}
                    disabled={pending}
                  >
                    카드 변경
                  </Button>
                  <Button variant="outline" onClick={cancel} disabled={pending}>
                    정기 결제 해지
                  </Button>
                </div>
              </div>
            ) : isScheduled && untilLabel ? (
              <div className="space-y-3">
                <div className="bg-muted border border-border p-3 text-sm text-muted-foreground">
                  현재 결제 기간은{" "}
                  <strong className="text-foreground">{untilLabel}</strong>까지
                  입니다. 이후 {intervalLabel} 정기 결제가 시작됩니다.
                </div>
                {renewalOverdue && <RenewalRetryNotice />}
                <div className="flex flex-col gap-2 sm:flex-row">
                  <Button
                    variant="outline"
                    onClick={changeCard}
                    disabled={pending}
                  >
                    카드 변경
                  </Button>
                  <Button variant="outline" onClick={cancel} disabled={pending}>
                    정기 결제 예약 취소
                  </Button>
                </div>
              </div>
            ) : isPastDue ? (
              // Stopped after its charges failed. The card stays registered
              // in case a late payment turns up; registering a new card below
              // restarts it, and cancelling removes the old one.
              <div className="space-y-3">
                <div className="bg-muted border border-border p-3 text-sm text-muted-foreground">
                  {intervalLabel} 정기 결제가 결제 실패로 멈췄습니다. 아래에서
                  카드를 다시 등록하면 곧바로 결제되어 다시 이어집니다.
                  {untilLabel && supportActive && (
                    <>
                      {" "}
                      <strong className="text-foreground">{untilLabel}</strong>
                      까지는 유료 기능을 이용하실 수 있습니다.
                    </>
                  )}
                </div>
                <div className="flex flex-col gap-2 sm:flex-row">
                  <Button variant="outline" onClick={cancel} disabled={pending}>
                    정기 결제 해지
                  </Button>
                </div>
              </div>
            ) : subscription?.status === "canceled" &&
              supportActive &&
              untilLabel ? (
              <div className="bg-muted border border-border p-3 text-sm text-muted-foreground">
                정기 결제가 종료되었습니다.{" "}
                <strong className="text-foreground">{untilLabel}</strong>까지
                유료 기능을 이용하실 수 있습니다.
              </div>
            ) : supportActive && untilLabel ? (
              <div className="bg-muted border border-border p-3 text-sm text-muted-foreground">
                일회성 결제로 이용 중입니다.{" "}
                <strong className="text-foreground">{untilLabel}</strong>까지
                유료 기능을 이용하실 수 있습니다.
              </div>
            ) : null}

            {!emailVerified && (
              <div className="space-y-3 border-2 border-yellow-500 bg-yellow-500/5 p-3 text-sm">
                <p className="text-yellow-800 dark:text-yellow-300">
                  {email
                    ? `결제 영수증과 결제 안내를 보내드려야 하므로, 결제를 시작하려면 먼저 이메일 인증이 필요합니다. ${email} 주소로 보낸 인증 메일을 확인해 주세요.`
                    : "결제 영수증과 결제 안내를 보내드려야 하므로, 결제를 시작하려면 인증된 이메일 주소가 필요합니다. 계정 관리에서 이메일을 등록해 주세요."}
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
                    <p className="text-xs text-muted-foreground">정기 결제</p>
                    <div className="flex flex-col sm:flex-row gap-2">
                      <Button
                        onClick={() => subscribe("month")}
                        disabled={pending}
                        className="flex-1"
                      >
                        {supportActive
                          ? "기간 종료 후 월 1,000원"
                          : "월 1,000원 결제"}
                      </Button>
                      <Button
                        onClick={() => subscribe("year")}
                        disabled={pending}
                        className="flex-1"
                      >
                        {supportActive
                          ? "기간 종료 후 연 10,000원"
                          : "연 10,000원 결제 (2개월 무료)"}
                      </Button>
                    </div>
                  </>
                )}
                {showOneTimeOptions && (
                  <>
                    <p className="text-xs text-muted-foreground pt-1">
                      {supportActive ? "남은 기간 뒤에 1년 더" : "한 번만 결제"}
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
