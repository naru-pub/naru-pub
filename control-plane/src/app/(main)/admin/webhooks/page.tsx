import type { Metadata } from "next";
import Link from "next/link";
import { db } from "@/lib/database";
import { Badge } from "@/components/ui/badge";
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
  isWebhookWindow,
  WEBHOOK_WINDOWS,
  webhookWindowStart,
  type WebhookWindow,
} from "../_components/metrics";
import { requireOperator } from "../_components/requireOperator";

export const metadata: Metadata = { title: "웹훅 · 운영 · 나루" };

function prettyPayload(payload: string | null) {
  if (!payload) return "—";
  try {
    return JSON.stringify(JSON.parse(payload), null, 2);
  } catch {
    return payload;
  }
}

export default async function WebhookDeliveriesPage({
  searchParams,
}: {
  searchParams: Promise<{ failed?: string; since?: string }>;
}) {
  await requireOperator();
  const params = await searchParams;
  const onlyFailed = params.failed === "1";
  const since: WebhookWindow | null = isWebhookWindow(params.since)
    ? params.since
    : null;
  const href = (changes: {
    failed?: boolean;
    since?: WebhookWindow | null;
  }) => {
    const next = new URLSearchParams();
    const nextFailed = changes.failed ?? onlyFailed;
    const nextSince = "since" in changes ? changes.since : since;
    if (nextFailed) next.set("failed", "1");
    if (nextSince) next.set("since", nextSince);
    const query = next.toString();
    return query ? `/admin/webhooks?${query}` : "/admin/webhooks";
  };

  const receivedAfter = since ? webhookWindowStart(since) : null;
  const deliveries = await db
    .selectFrom("toss_webhook_deliveries")
    .selectAll()
    .$if(onlyFailed, (qb) => qb.where("http_status", ">=", 500))
    .$if(receivedAfter !== null, (qb) =>
      qb.where("received_at", ">=", receivedAfter!),
    )
    .orderBy("id", "desc")
    .limit(200)
    .execute();

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Toss가 보낸 웹훅과 나루가 한 일을 최근 200건까지 보여 줍니다(90일 보관).
        5xx로 답한 웹훅은 Toss가 다시 보냅니다. 보낸 쪽 기록은{" "}
        <a
          href="https://developers.tosspayments.com/my/webhooks"
          className="underline"
          target="_blank"
          rel="noreferrer"
        >
          개발자센터
        </a>
        에 있습니다.
      </p>
      <div className="flex flex-wrap gap-3 text-sm">
        <Link
          href={href({ since: null })}
          className={since === null ? "font-bold" : "text-muted-foreground"}
        >
          전체 기간
        </Link>
        {(Object.keys(WEBHOOK_WINDOWS) as WebhookWindow[]).map((key) => (
          <Link
            key={key}
            href={href({ since: key })}
            className={since === key ? "font-bold" : "text-muted-foreground"}
          >
            {WEBHOOK_WINDOWS[key].label}
          </Link>
        ))}
        <span className="text-muted-foreground">|</span>
        <Link
          href={href({ failed: !onlyFailed })}
          className={onlyFailed ? "font-bold" : "text-muted-foreground"}
        >
          재시도 요청(5xx)만
        </Link>
      </div>

      <div className="overflow-x-auto border-2 border-border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>받은 시각</TableHead>
              <TableHead>이벤트</TableHead>
              <TableHead>대상</TableHead>
              <TableHead>Toss 상태</TableHead>
              <TableHead>처리</TableHead>
              <TableHead>응답</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {deliveries.map((delivery) => (
              <TableRow key={delivery.id} className="align-top">
                <TableCell className="whitespace-nowrap">
                  {formatDate(delivery.received_at)}
                  {delivery.retried_count ? (
                    <span className="block text-xs text-muted-foreground">
                      재전송 {delivery.retried_count}회째
                    </span>
                  ) : null}
                </TableCell>
                <TableCell className="whitespace-nowrap">
                  {delivery.event_type}
                </TableCell>
                <TableCell className="font-mono text-xs">
                  {delivery.subject ?? "-"}
                </TableCell>
                <TableCell>{delivery.toss_status ?? "-"}</TableCell>
                <TableCell className="max-w-xl">
                  <span className="break-words">{delivery.outcome}</span>
                  <details className="mt-1">
                    <summary className="cursor-pointer text-xs text-muted-foreground">
                      본문
                      {delivery.transmission_id
                        ? ` · ${delivery.transmission_id}`
                        : ""}
                    </summary>
                    <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-all bg-muted p-2 text-xs">
                      {prettyPayload(delivery.payload)}
                    </pre>
                  </details>
                </TableCell>
                <TableCell className="whitespace-nowrap">
                  <Badge
                    variant={
                      delivery.http_status >= 500 ? "destructive" : "secondary"
                    }
                  >
                    {delivery.http_status}
                  </Badge>
                  <span className="block text-xs text-muted-foreground">
                    {delivery.duration_ms}ms
                  </span>
                </TableCell>
              </TableRow>
            ))}
            {deliveries.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={6}
                  className="py-10 text-center text-muted-foreground"
                >
                  받은 웹훅이 없습니다.
                </TableCell>
              </TableRow>
            ) : null}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
