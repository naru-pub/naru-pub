import type { Metadata } from "next";
import Link from "next/link";
import { sql } from "kysely";
import { db } from "@/lib/database";
import { maskSecret } from "@/lib/toss";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatDate, formatKrw } from "../_components/format";
import { SUBSCRIPTION_STATUS_LABELS } from "../_components/metrics";
import { requireOperator } from "../_components/requireOperator";

export const metadata: Metadata = { title: "정기 결제 · 운영 · 나루" };

export default async function SubscriptionsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  await requireOperator();
  const { status: statusParam } = await searchParams;
  const status =
    statusParam && statusParam in SUBSCRIPTION_STATUS_LABELS
      ? statusParam
      : null;

  const counts = await db
    .selectFrom("subscriptions")
    .select(["status", sql<number>`count(*)::int`.as("count")])
    .groupBy("status")
    .execute();
  const countOf = new Map(counts.map((row) => [row.status, row.count]));
  const total = counts.reduce((sum, row) => sum + row.count, 0);

  const subscriptions = await db
    .selectFrom("subscriptions")
    .innerJoin("users", "users.id", "subscriptions.user_id")
    .select([
      "subscriptions.id",
      "subscriptions.status",
      "subscriptions.billing_interval",
      "subscriptions.amount",
      "subscriptions.toss_billing_key",
      "subscriptions.current_period_end",
      "subscriptions.next_billing_at",
      "subscriptions.failed_charge_count",
      "subscriptions.charging_started_at",
      "subscriptions.canceled_at",
      "subscriptions.updated_at",
      "users.login_name",
      "users.supporter_until",
    ])
    .$if(status !== null, (qb) =>
      qb.where("subscriptions.status", "=", status!),
    )
    .orderBy("subscriptions.updated_at", "desc")
    .limit(200)
    .execute();

  const shown = status ? (countOf.get(status) ?? 0) : total;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap gap-2 text-sm">
        <Link
          href="/admin/subscriptions"
          className={`border-2 px-3 py-1 ${status === null ? "border-primary font-bold" : "border-border text-muted-foreground"}`}
        >
          전체 {total}
        </Link>
        {Object.entries(SUBSCRIPTION_STATUS_LABELS).map(([key, label]) => (
          <Link
            key={key}
            href={`/admin/subscriptions?status=${key}`}
            className={`border-2 px-3 py-1 ${status === key ? "border-primary font-bold" : "border-border text-muted-foreground"}`}
          >
            {label} {countOf.get(key) ?? 0}
          </Link>
        ))}
      </div>

      <div className="space-y-1">
        <h2 className="text-xl font-bold">
          {status
            ? `정기 결제 · ${SUBSCRIPTION_STATUS_LABELS[status]}`
            : "정기 결제"}
        </h2>
        <p className="text-sm text-muted-foreground">
          계정마다 한 행입니다. {shown}건
          {shown > subscriptions.length
            ? ` · 최근에 바뀐 ${subscriptions.length}건만 표시`
            : ""}
        </p>
      </div>

      <div className="overflow-x-auto border-2 border-border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>계정</TableHead>
              <TableHead>상태</TableHead>
              <TableHead>플랜</TableHead>
              <TableHead>기간 끝</TableHead>
              <TableHead>다음 결제</TableHead>
              <TableHead>이용 기한</TableHead>
              <TableHead>실패</TableHead>
              <TableHead>빌링키</TableHead>
              <TableHead>바뀐 시각</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {subscriptions.map((sub) => (
              <TableRow key={sub.id}>
                <TableCell className="font-medium">
                  <Link
                    href={`/admin/events?user=${encodeURIComponent(sub.login_name)}`}
                    className="underline"
                  >
                    {sub.login_name}
                  </Link>
                </TableCell>
                <TableCell>
                  <Badge
                    variant={
                      sub.status === "past_due" ? "destructive" : "outline"
                    }
                  >
                    {SUBSCRIPTION_STATUS_LABELS[sub.status] ?? sub.status}
                  </Badge>
                  {sub.charging_started_at ? (
                    <span className="block text-xs text-muted-foreground">
                      청구 중 ({formatDate(sub.charging_started_at)})
                    </span>
                  ) : null}
                </TableCell>
                <TableCell className="whitespace-nowrap">
                  {sub.billing_interval === "year" ? "연간" : "월간"}{" "}
                  {formatKrw(sub.amount)}
                </TableCell>
                <TableCell className="whitespace-nowrap">
                  {formatDate(sub.current_period_end)}
                </TableCell>
                <TableCell className="whitespace-nowrap">
                  {formatDate(sub.next_billing_at)}
                </TableCell>
                <TableCell className="whitespace-nowrap">
                  {formatDate(sub.supporter_until)}
                </TableCell>
                <TableCell>{sub.failed_charge_count || "-"}</TableCell>
                <TableCell className="font-mono text-xs">
                  {sub.toss_billing_key
                    ? maskSecret(sub.toss_billing_key)
                    : "-"}
                </TableCell>
                <TableCell className="whitespace-nowrap">
                  {formatDate(sub.updated_at)}
                </TableCell>
              </TableRow>
            ))}
            {subscriptions.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={9}
                  className="py-10 text-center text-muted-foreground"
                >
                  해당하는 정기 결제가 없습니다.
                </TableCell>
              </TableRow>
            ) : null}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
