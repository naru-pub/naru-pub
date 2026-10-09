import type { Metadata } from "next";
import Link from "next/link";
import { db } from "@/lib/database";
import { addPaymentGrace, isCurrentPlan } from "@/lib/payments/subscriptions";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatDate } from "../_components/format";
import {
  SUBSCRIPTION_STATUS_LABELS,
  supporterCondition,
} from "../_components/metrics";
import { requireOperator } from "../_components/requireOperator";

export const metadata: Metadata = { title: "유료 이용자 · 운영 · 나루" };

export default async function SupportersPage() {
  await requireOperator();
  const now = new Date();

  const supporters = await db
    .selectFrom("users")
    .leftJoin("subscriptions", (join) =>
      join.onRef("subscriptions.user_id", "=", "users.id").on(isCurrentPlan),
    )
    .select([
      "users.id",
      "users.login_name",
      "users.supporter_comp",
      "users.supporter_until",
      "subscriptions.status as subscription_status",
      "subscriptions.next_billing_at",
    ])
    .where(supporterCondition(now))
    .orderBy("users.supporter_comp", "desc")
    .orderBy("users.supporter_until", "asc")
    .execute();

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h2 className="text-xl font-bold">유료 이용자</h2>
        <p className="text-sm text-muted-foreground">
          지금 유료 기능을 쓸 수 있는 계정입니다: 무료 제공 계정과, 이용 기한이
          남았거나 결제 유예 기간 안인 계정. {supporters.length}명 · 이용 기한이
          가까운 순서.
        </p>
      </div>

      <Card>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>계정</TableHead>
              <TableHead>이용</TableHead>
              <TableHead>이용 기한</TableHead>
              <TableHead>정기 결제</TableHead>
              <TableHead>다음 결제</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {supporters.map((user) => {
              const until = user.supporter_until
                ? new Date(user.supporter_until)
                : null;
              const inGrace =
                !user.supporter_comp &&
                until !== null &&
                until <= now &&
                addPaymentGrace(until) > now;
              return (
                <TableRow key={user.id}>
                  <TableCell className="font-medium">
                    <Link
                      href={`/admin/events?user=${encodeURIComponent(user.login_name)}`}
                      className="underline"
                    >
                      {user.login_name}
                    </Link>
                  </TableCell>
                  <TableCell>
                    {user.supporter_comp ? (
                      <Badge variant="secondary">무료 제공</Badge>
                    ) : inGrace ? (
                      <Badge variant="destructive">결제 유예 중</Badge>
                    ) : (
                      <Badge variant="outline">결제</Badge>
                    )}
                  </TableCell>
                  <TableCell className="whitespace-nowrap tabular-nums">
                    {user.supporter_comp
                      ? "-"
                      : formatDate(user.supporter_until)}
                  </TableCell>
                  <TableCell>
                    {user.subscription_status
                      ? (SUBSCRIPTION_STATUS_LABELS[user.subscription_status] ??
                        user.subscription_status)
                      : "-"}
                  </TableCell>
                  <TableCell className="whitespace-nowrap tabular-nums">
                    {formatDate(user.next_billing_at)}
                  </TableCell>
                </TableRow>
              );
            })}
            {supporters.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={5}
                  className="py-10 text-center text-muted-foreground"
                >
                  유료 이용자가 없습니다.
                </TableCell>
              </TableRow>
            ) : null}
          </TableBody>
        </Table>
      </Card>
    </div>
  );
}
