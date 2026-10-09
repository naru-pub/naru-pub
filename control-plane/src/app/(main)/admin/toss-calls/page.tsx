import type { Metadata } from "next";
import Link from "next/link";
import { db } from "@/lib/database";
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
import { requireOperator } from "../_components/requireOperator";

export const metadata: Metadata = { title: "Toss 호출 · 운영 · 나루" };

function pretty(body: unknown) {
  if (body == null) return "—";
  return JSON.stringify(body, null, 2);
}

// Every request 나루 made to Toss and its answer (toss_calls, 5 years), for
// "what did Toss actually say". Billing keys and secrets are masked.
export default async function TossCallsPage({
  searchParams,
}: {
  searchParams: Promise<{ order?: string; failed?: string }>;
}) {
  await requireOperator();
  const params = await searchParams;
  const order = params.order?.trim() || null;
  const onlyFailed = params.failed === "1";

  const calls = await db
    .selectFrom("toss_calls")
    .selectAll()
    .$if(order !== null, (qb) => qb.where("order_id", "=", order!))
    .$if(onlyFailed, (qb) =>
      qb.where((eb) =>
        eb.or([eb("http_status", ">=", 400), eb("http_status", "is", null)]),
      ),
    )
    .orderBy("id", "desc")
    .limit(200)
    .execute();

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        나루가 Toss에 보낸 요청과 받은 답을 최근 200건까지 보여 줍니다(5년
        보관). 빌링키와 비밀값은 가려 둡니다.{" "}
        <Link
          href={onlyFailed ? "/admin/toss-calls" : "/admin/toss-calls?failed=1"}
          className="underline"
        >
          {onlyFailed ? "전체 보기" : "실패한 호출만"}
        </Link>
        {order ? (
          <>
            {" · "}주문 {order}{" "}
            <Link href="/admin/toss-calls" className="underline">
              (전체)
            </Link>
          </>
        ) : null}
      </p>
      <Card>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>시각</TableHead>
              <TableHead>요청</TableHead>
              <TableHead>주문</TableHead>
              <TableHead>응답</TableHead>
              <TableHead>시간</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {calls.map((call) => (
              <TableRow key={call.id}>
                <TableCell className="whitespace-nowrap tabular-nums">
                  {formatDate(call.created_at)}
                </TableCell>
                <TableCell className="max-w-md">
                  <span className="font-mono text-xs break-all">
                    {call.method} {call.path}
                  </span>
                  <span className="block text-xs text-muted-foreground">
                    {call.flow === "billing" ? "자동결제" : "한 번만 결제"}
                  </span>
                  <details className="mt-1">
                    <summary className="cursor-pointer text-xs text-muted-foreground">
                      본문
                    </summary>
                    <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-all bg-muted p-2 text-xs">
                      {`요청\n${pretty(call.request_body)}\n\n응답\n${pretty(call.response_body)}`}
                    </pre>
                  </details>
                </TableCell>
                <TableCell className="font-mono text-xs">
                  {call.order_id ? (
                    <Link
                      href={`/admin/toss-calls?order=${encodeURIComponent(call.order_id)}`}
                      className="underline"
                    >
                      {call.order_id}
                    </Link>
                  ) : (
                    "-"
                  )}
                </TableCell>
                <TableCell className="whitespace-nowrap">
                  <Badge
                    variant={
                      call.http_status == null || call.http_status >= 400
                        ? "destructive"
                        : "secondary"
                    }
                  >
                    {call.http_status ?? "응답 없음"}
                  </Badge>
                  {call.error_code || call.error ? (
                    <span className="block text-xs text-muted-foreground">
                      {call.error_code ?? call.error}
                    </span>
                  ) : null}
                </TableCell>
                <TableCell className="whitespace-nowrap font-mono text-xs">
                  {call.duration_ms}ms
                </TableCell>
              </TableRow>
            ))}
            {calls.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={5}
                  className="py-10 text-center text-muted-foreground"
                >
                  Toss 호출 기록이 없습니다.
                </TableCell>
              </TableRow>
            ) : null}
          </TableBody>
        </Table>
      </Card>
    </div>
  );
}
