import type { Metadata } from "next";
import { sql } from "kysely";
import { db } from "@/lib/database";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
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

export const metadata: Metadata = { title: "결제 기록 · 운영 · 나루" };

const MAIL_KINDS: Record<string, string> = {
  thank_you: "감사",
  charge_receipt: "결제 완료",
  renewal_notice: "갱신 예정",
  grace_notice: "결제 실패(유예)",
  past_due_notice: "연체",
  payment_canceled: "결제 취소",
  subscription_canceled: "해지",
};

// What payments leave nowhere else: the last run of each payment cron job,
// payment mail sent and failed, and Toss windows that did not succeed.
export default async function PaymentRecordsPage({
  searchParams,
}: {
  searchParams: Promise<{ user?: string }>;
}) {
  await requireOperator();
  const loginName = (await searchParams).user?.trim() || null;
  const user = loginName
    ? await db
        .selectFrom("users")
        .select("id")
        .where("login_name", "=", loginName)
        .executeTakeFirst()
    : null;

  const [runs, mails, windows] = await Promise.all([
    db
      .selectFrom("payment_cron_runs as r")
      .selectAll("r")
      .where(
        "r.id",
        "in",
        db
          .selectFrom("payment_cron_runs")
          .select(
            sql<string>`(array_agg(id order by started_at desc))[1]`.as("id"),
          )
          .groupBy("script"),
      )
      .orderBy("r.script")
      .execute(),
    db
      .selectFrom("payment_mails")
      .leftJoin("users", "users.id", "payment_mails.user_id")
      .selectAll("payment_mails")
      .select("users.login_name")
      .$if(user != null, (qb) =>
        qb.where("payment_mails.user_id", "=", user!.id),
      )
      .orderBy("payment_mails.id", "desc")
      .limit(100)
      .execute(),
    db
      .selectFrom("toss_window_outcomes")
      .leftJoin("users", "users.id", "toss_window_outcomes.user_id")
      .selectAll("toss_window_outcomes")
      .select("users.login_name")
      .$if(user != null, (qb) =>
        qb.where("toss_window_outcomes.user_id", "=", user!.id),
      )
      .orderBy("toss_window_outcomes.id", "desc")
      .limit(100)
      .execute(),
  ]);

  return (
    <div className="space-y-8">
      <form className="flex gap-2">
        <Input
          name="user"
          defaultValue={loginName ?? ""}
          placeholder="계정 이름으로 거르기"
          aria-label="계정 이름"
          className="h-9 w-56"
        />
        <Button type="submit" variant="outline" size="sm">
          보기
        </Button>
      </form>

      <section className="space-y-2">
        <h2 className="text-xl font-bold">결제 작업의 마지막 실행</h2>
        <p className="text-sm text-muted-foreground">
          작업마다 가장 최근 실행(1년 보관). 매분 도는 작업 대기열은 한 일이
          있거나 실패한 실행만 남깁니다.
        </p>
        <Card>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>작업</TableHead>
                <TableHead>시작</TableHead>
                <TableHead>결과</TableHead>
                <TableHead>출력 끝부분</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {runs.map((run) => (
                <TableRow key={run.id}>
                  <TableCell className="font-mono text-xs">
                    {run.script}
                  </TableCell>
                  <TableCell className="whitespace-nowrap tabular-nums">
                    {formatDate(run.started_at)}
                  </TableCell>
                  <TableCell>
                    {run.timed_out ? (
                      <Badge variant="destructive">시간 초과</Badge>
                    ) : run.exit_code === 0 ? (
                      <Badge variant="success">성공</Badge>
                    ) : (
                      <Badge variant="destructive">
                        종료 코드 {run.exit_code ?? "없음"}
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell className="max-w-xl whitespace-pre-wrap break-words font-mono text-xs">
                    {run.output_tail?.split("\n").slice(-6).join("\n") ?? "—"}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      </section>

      <section className="space-y-2">
        <h2 className="text-xl font-bold">결제 메일</h2>
        <p className="text-sm text-muted-foreground">
          최근 100통(1년 보관). 실패한 메일은 결제 작업 대기열이 다시 보냅니다.
        </p>
        <Card>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>시각</TableHead>
                <TableHead>종류</TableHead>
                <TableHead>계정</TableHead>
                <TableHead>받는 사람</TableHead>
                <TableHead>결과</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {mails.map((mail) => (
                <TableRow key={mail.id}>
                  <TableCell className="whitespace-nowrap tabular-nums">
                    {formatDate(mail.created_at)}
                  </TableCell>
                  <TableCell>{MAIL_KINDS[mail.kind] ?? mail.kind}</TableCell>
                  <TableCell>{mail.login_name ?? "—"}</TableCell>
                  <TableCell className="font-mono text-xs">
                    {mail.recipient}
                  </TableCell>
                  <TableCell className="max-w-md break-words text-xs">
                    {mail.error ? (
                      <Badge variant="destructive">{mail.error}</Badge>
                    ) : (
                      <span className="font-mono">
                        {mail.message_id ?? "보냄"}
                      </span>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      </section>

      <section className="space-y-2">
        <h2 className="text-xl font-bold">성공하지 못한 결제창</h2>
        <p className="text-sm text-muted-foreground">
          카드 등록이나 결제 창이 실패하거나 닫혔을 때 Toss가 알려 준 코드와
          메시지(5년 보관). API 호출에는 남지 않는 기록입니다.
        </p>
        <Card>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>시각</TableHead>
                <TableHead>계정</TableHead>
                <TableHead>창</TableHead>
                <TableHead>코드</TableHead>
                <TableHead>메시지</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {windows.map((outcome) => (
                <TableRow key={outcome.id}>
                  <TableCell className="whitespace-nowrap tabular-nums">
                    {formatDate(outcome.created_at)}
                  </TableCell>
                  <TableCell>{outcome.login_name ?? "—"}</TableCell>
                  <TableCell>
                    {outcome.window === "billing_auth" ? (
                      "카드 등록"
                    ) : (
                      <>
                        결제{" "}
                        <span className="font-mono text-xs">
                          {outcome.order_id}
                        </span>
                      </>
                    )}
                  </TableCell>
                  <TableCell className="font-mono text-xs">
                    {outcome.code}
                  </TableCell>
                  <TableCell className="max-w-md break-words">
                    {outcome.message ?? "—"}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      </section>
    </div>
  );
}
