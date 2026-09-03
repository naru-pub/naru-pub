import Link from "next/link";
import { Heart, ReceiptText } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { SupportPerks } from "@/components/SupportPerks";
import { SupportPolicy } from "@/components/SupportPolicy";
import { validateRequest } from "@/lib/auth";
import { db } from "@/lib/database";
import { getUserEntitlement } from "@/lib/entitlements";
import { hasVerifiedEmail } from "@/lib/support";
import { ONE_TIME_YEAR_AMOUNT, PLAN_AMOUNTS } from "@/lib/toss";
import SupportCard from "../account/SupportCard";

const krw = (amount: number) => `${amount.toLocaleString("ko-KR")}원`;

// 결제 없이 상품과 가격만 보여주는 비회원 화면. 카드사 심사관은 로그인하지
// 않은 채로 '메인 - 상품 - 결제' 경로를 확인하므로 이 페이지가 로그인 뒤에
// 숨어 있으면 심사가 반려된다.
function SignedOutSupportCard() {
  return (
    <Card className="rounded-none bg-card border-2 border-border shadow-lg">
      <CardHeader className="bg-secondary border-b-2 border-border">
        <CardTitle className="text-foreground text-xl font-bold flex items-center gap-2">
          <Heart size={20} />
          나루 후원
        </CardTitle>
      </CardHeader>
      <CardContent className="p-6 space-y-4">
        <p className="text-sm text-muted-foreground">
          나루는 후원으로 굴러가는 작은 인디웹 서비스입니다. 후원해 주시면 아래
          후원자 전용 기능을 쓰실 수 있습니다 🌱
        </p>

        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">정기 후원</p>
          <div className="flex flex-col gap-2 sm:flex-row">
            <div className="flex-1 border-2 border-border bg-background p-3 text-sm">
              <strong className="text-foreground">
                월 {krw(PLAN_AMOUNTS.month)}
              </strong>
              <p className="text-muted-foreground">매월 자동 결제</p>
            </div>
            <div className="flex-1 border-2 border-border bg-background p-3 text-sm">
              <strong className="text-foreground">
                연 {krw(PLAN_AMOUNTS.year)}
              </strong>
              <p className="text-muted-foreground">
                매년 자동 결제 (2개월 무료)
              </p>
            </div>
          </div>
          <p className="text-xs text-muted-foreground pt-1">한 번만 후원</p>
          <div className="border-2 border-border bg-background p-3 text-sm">
            <strong className="text-foreground">
              {krw(ONE_TIME_YEAR_AMOUNT)}
            </strong>
            <p className="text-muted-foreground">1년, 자동 갱신 없음</p>
          </div>
        </div>

        <div className="flex flex-col gap-2 sm:flex-row">
          <Button asChild className="flex-1">
            <Link href="/login?next=/support">로그인하고 후원하기</Link>
          </Button>
          <Button asChild variant="outline" className="flex-1">
            <Link href="/signup">회원가입</Link>
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          후원은 나루 계정으로 결제합니다. 결제 수단은 신용·체크카드이며, 결제
          창은 토스페이먼츠를 통해 열립니다.
        </p>
      </CardContent>
    </Card>
  );
}

export default async function SupportPage() {
  const { user } = await validateRequest();

  if (!user) {
    return (
      <div className="bg-background min-h-screen">
        <div className="max-w-4xl mx-auto p-6 space-y-4">
          <SignedOutSupportCard />
          <SupportPerks />
          <SupportPolicy />
        </div>
      </div>
    );
  }

  const entitlement = await getUserEntitlement(user.id);
  const subscriptionRow = await db
    .selectFrom("subscriptions")
    .select(["status", "billing_interval", "next_billing_at"])
    .where("user_id", "=", user.id)
    .executeTakeFirst();
  const subscription = subscriptionRow
    ? {
        status: subscriptionRow.status,
        billingInterval: subscriptionRow.billing_interval,
        nextBillingAt: subscriptionRow.next_billing_at
          ? new Date(subscriptionRow.next_billing_at).toISOString()
          : null,
      }
    : null;

  return (
    <div className="bg-background min-h-screen">
      <div className="max-w-4xl mx-auto p-6 space-y-4">
        <SupportCard
          clientKey={process.env.TOSS_CLIENT_KEY ?? ""}
          comp={entitlement.comp}
          supportActive={entitlement.paid}
          supporterUntil={
            entitlement.supporterUntil
              ? entitlement.supporterUntil.toISOString()
              : null
          }
          subscription={subscription}
          email={user.email}
          emailVerified={hasVerifiedEmail(user)}
        />
        <SupportPerks />
        <SupportPolicy />
        <div className="flex justify-end">
          <Button asChild variant="outline">
            <Link href="/support/payments">
              <ReceiptText size={16} />
              결제 내역 보기
            </Link>
          </Button>
        </div>
      </div>
    </div>
  );
}
