import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ScrollText } from "lucide-react";

import {
  MAX_PURCHASABLE_ONE_TIME_YEARS,
  ONE_TIME_YEAR_AMOUNT,
  PLAN_AMOUNTS,
} from "@/lib/toss";

const krw = (amount: number) => `${amount.toLocaleString("ko-KR")}원`;

// 카드사 심사는 무형재화의 판매 정책 — 상품 가격, 서비스 제공기간, 환불정책 —
// 이 구매 페이지에서 비회원에게도 그대로 보이는지를 확인한다. 문구를 고칠
// 때는 실제 동작(정기 결제 취소는 기간 만료까지 유지, 환불은 후원자 기능을
// 즉시 종료)과 어긋나지 않게 해야 한다.
export function SupportPolicy() {
  return (
    <Card className="rounded-none bg-card border-2 border-border shadow-lg">
      <CardHeader className="bg-secondary border-b-2 border-border">
        <CardTitle className="text-foreground text-xl font-bold flex items-center gap-2">
          <ScrollText size={20} />
          후원 상품 안내 및 판매 정책
        </CardTitle>
      </CardHeader>
      <CardContent className="p-6 space-y-6 text-sm">
        <section className="space-y-2">
          <h3 className="font-bold text-foreground">상품 및 가격</h3>
          <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
            <li>
              정기 후원 (월간) &mdash;{" "}
              <strong className="text-foreground">
                {krw(PLAN_AMOUNTS.month)}
              </strong>
              , 매월 자동 결제
            </li>
            <li>
              정기 후원 (연간) &mdash;{" "}
              <strong className="text-foreground">
                {krw(PLAN_AMOUNTS.year)}
              </strong>
              , 매년 자동 결제
            </li>
            <li>
              일회성 후원 (1년) &mdash;{" "}
              <strong className="text-foreground">
                {krw(ONE_TIME_YEAR_AMOUNT)}
              </strong>
              , 자동 갱신 없음
            </li>
          </ul>
          <p className="text-muted-foreground">
            표시된 금액이 실제 결제 금액입니다. 후원자는 커스텀 도메인,
            데이터베이스, 방문자 현황 기능을 이용할 수 있습니다.
            나루의 기본 웹사이트 호스팅은 후원 여부와 관계없이 무료입니다.
          </p>
        </section>

        <section className="space-y-2">
          <h3 className="font-bold text-foreground">서비스 제공기간</h3>
          <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
            <li>정기 후원 (월간): 결제일로부터 1개월</li>
            <li>정기 후원 (연간): 결제일로부터 1년</li>
            <li>
              일회성 후원: 결제일로부터 {MAX_PURCHASABLE_ONE_TIME_YEARS}년
            </li>
          </ul>
          <p className="text-muted-foreground">
            후원자 전용 기능은 결제가 완료된 직후 바로 사용할 수 있으며, 한
            번의 결제로 제공되는 기간은 최대 1년입니다.
          </p>
        </section>

        <section className="space-y-2">
          <h3 className="font-bold text-foreground">환불정책</h3>
          <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
            <li>
              결제일로부터 7일 이내에 후원자 전용 기능을 사용하지 않으셨다면
              전액 환불해 드립니다.
            </li>
            <li>
              환불이 완료되면 해당 결제로 제공된 후원자 전용 기능은 즉시
              종료되며, 커스텀 도메인·데이터베이스·방문자 현황을 더 이상 이용할
              수 없습니다. 무료로 제공되는 웹사이트 호스팅은 그대로 유지됩니다.
            </li>
            <li>
              정기 후원은 언제든지 취소할 수 있습니다. 취소하시면 다음 결제부터
              청구되지 않고, 이미 결제하신 기간은 만료일까지 그대로 이용하실 수
              있습니다. 이미 시작된 기간에 대한 일할 환불은 제공하지 않습니다.
            </li>
            <li>
              나루의 장애나 서비스 중단으로 후원자 전용 기능을 이용하지 못한
              경우에는 기간 경과와 관계없이 환불해 드립니다.
            </li>
          </ul>
        </section>

        <section className="space-y-2">
          <h3 className="font-bold text-foreground">환불 및 문의 방법</h3>
          <p className="text-muted-foreground">
            환불을 원하시면{" "}
            <a
              href="mailto:hi@naru.pub"
              className="text-primary underline hover:text-primary/80"
            >
              hi@naru.pub
            </a>{" "}
            으로 결제하신 계정의 아이디와 결제일을 알려주세요. 3영업일 이내에
            처리해 드립니다. 페이지 아래 사업자정보에 적힌 유선번호로 연락하셔도
            됩니다. 환불 대금은 결제하신 카드로 취소되며, 카드사에 따라 영업일
            기준 3~5일이 더 걸릴 수 있습니다.
          </p>
        </section>
      </CardContent>
    </Card>
  );
}
