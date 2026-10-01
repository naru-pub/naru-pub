"use client";

import { Fragment, useState } from "react";
import { FlaskConical } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

// Mirrors lib/billing-lab.ts, which pulls in server code and so is not
// imported here.
type Row = Record<string, string | number | boolean | null>;
type Snapshot = {
  user: Row | null;
  subscription: Row | null;
  payments: Row[];
  retiredKeys: Row[];
};
type TossCall = {
  flow: string;
  method: string;
  path: string;
  testCode: string | null;
  requestBody: unknown;
  status: number | null;
  responseBody: unknown;
  error: string | null;
  durationMs: number;
};
type LabResult = {
  ok: boolean;
  message: string;
  calls: TossCall[];
  before: Snapshot | null;
  after: Snapshot | null;
};
type Run = { id: number; label: string; at: string; result: LabResult };

export type LabAccount = {
  userId: number;
  loginName: string;
  subscriptionId: number | null;
  subscriptionStatus: string | null;
};

const PAYMENT_COLUMNS = [
  "id",
  "attempt_key",
  "order_id",
  "status",
  "amount",
  "refunded_amount",
  "paid_at",
  "period_end",
  "reconciliation_error",
];

function show(value: Row[string] | undefined) {
  if (value === null || value === undefined) return "—";
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/.test(value)) {
    return new Intl.DateTimeFormat("ko-KR", {
      dateStyle: "short",
      timeStyle: "medium",
      timeZone: "Asia/Seoul",
    }).format(new Date(value));
  }
  return String(value);
}

function Json({ value }: { value: unknown }) {
  if (value === null || value === undefined) {
    return <span className="text-muted-foreground">—</span>;
  }
  return (
    <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all bg-muted p-2 text-xs">
      {typeof value === "string" ? value : JSON.stringify(value, null, 2)}
    </pre>
  );
}

// One record (user or subscription), before → after, changed fields marked.
function RecordDiff({
  title,
  before,
  after,
}: {
  title: string;
  before: Row | null;
  after: Row | null;
}) {
  const keys = Object.keys(after ?? before ?? {});
  if (keys.length === 0) {
    return <div className="text-sm text-muted-foreground">{title}: 없음</div>;
  }
  return (
    <div>
      <div className="mb-1 text-sm font-semibold">{title}</div>
      <table className="w-full text-xs">
        <tbody>
          {keys.map((key) => {
            const changed = before?.[key] !== after?.[key];
            return (
              <tr
                key={key}
                className={changed ? "bg-yellow-500/15 font-medium" : ""}
              >
                <td className="py-0.5 pr-3 align-top text-muted-foreground">
                  {key}
                </td>
                <td className="py-0.5 pr-3 align-top">
                  {changed ? (
                    <span className="line-through opacity-60">
                      {show(before?.[key])}
                    </span>
                  ) : (
                    show(after?.[key])
                  )}
                </td>
                <td className="py-0.5 align-top">
                  {changed ? show(after?.[key]) : ""}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// Payment rows after the action; new rows and changed cells are marked.
function PaymentsDiff({
  before,
  after,
  columns = PAYMENT_COLUMNS,
  empty = "결제 기록 없음",
  actions,
}: {
  before: Row[];
  after: Row[];
  columns?: string[];
  empty?: string;
  actions?: (payment: Row) => React.ReactNode;
}) {
  const beforeById = new Map(before.map((row) => [row.id, row]));
  if (after.length === 0) {
    return <div className="text-sm text-muted-foreground">{empty}</div>;
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="text-left text-muted-foreground">
            {columns.map((column) => (
              <th key={column} className="py-1 pr-3 font-normal">
                {column}
              </th>
            ))}
            {actions ? <th /> : null}
          </tr>
        </thead>
        <tbody>
          {after.map((row) => {
            const old = beforeById.get(row.id);
            return (
              <tr
                key={String(row.id)}
                className={old ? "" : "bg-green-500/15 font-medium"}
              >
                {columns.map((column) => {
                  const changed = old && old[column] !== row[column];
                  return (
                    <td
                      key={column}
                      className={`py-1 pr-3 align-top ${changed ? "bg-yellow-500/15 font-medium" : ""}`}
                      title={changed ? `이전: ${show(old[column])}` : undefined}
                    >
                      {show(row[column])}
                    </td>
                  );
                })}
                {actions ? (
                  <td className="py-1 whitespace-nowrap">{actions(row)}</td>
                ) : null}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function TossCalls({ calls }: { calls: TossCall[] }) {
  if (calls.length === 0) {
    return (
      <div className="text-sm text-muted-foreground">
        Toss API를 호출하지 않았습니다.
      </div>
    );
  }
  return (
    <div className="space-y-2">
      {calls.map((call, index) => (
        <details key={index} className="border border-border" open>
          <summary className="flex cursor-pointer flex-wrap items-center gap-2 px-2 py-1 text-xs">
            <Badge
              variant={
                call.status && call.status < 300 ? "secondary" : "destructive"
              }
            >
              {call.status ?? "응답 없음"}
            </Badge>
            <span className="font-mono">
              {call.method} {call.path}
            </span>
            <span className="text-muted-foreground">
              {call.flow} · {call.durationMs}ms
            </span>
            {call.testCode ? (
              <Badge variant="outline">Test-Code: {call.testCode}</Badge>
            ) : null}
          </summary>
          <div className="grid gap-2 p-2 md:grid-cols-2">
            <div>
              <div className="mb-1 text-xs text-muted-foreground">요청</div>
              <Json value={call.requestBody} />
            </div>
            <div>
              <div className="mb-1 text-xs text-muted-foreground">응답</div>
              {call.error ? (
                <div className="text-xs text-destructive">{call.error}</div>
              ) : (
                <Json value={call.responseBody} />
              )}
            </div>
          </div>
        </details>
      ))}
    </div>
  );
}

export function BillingLab({
  accounts,
  testCodes,
}: {
  accounts: LabAccount[];
  testCodes: ReadonlyArray<{ code: string; label: string }>;
}) {
  const [userId, setUserId] = useState<number | null>(null);
  const [testCode, setTestCode] = useState("");
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [runs, setRuns] = useState<Run[]>([]);
  const [pending, setPending] = useState(false);

  async function run(label: string, body: Record<string, unknown>) {
    setPending(true);
    try {
      const response = await fetch("/api/admin/billing-lab", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await response.json();
      if (!response.ok || !data.success) {
        throw new Error(data.message ?? "실험을 실행하지 못했습니다.");
      }
      const result = data.result as LabResult;
      if (result.after) setSnapshot(result.after);
      if (body.action !== "inspect") {
        setRuns((previous) =>
          [
            {
              id: Date.now(),
              label,
              at: new Date().toISOString(),
              result,
            },
            ...previous,
          ].slice(0, 10),
        );
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setPending(false);
    }
  }

  function selectAccount(value: string) {
    const id = Number(value) || null;
    setUserId(id);
    setSnapshot(null);
    if (id) void run("상태 보기", { action: "inspect", userId: id });
  }

  const subscriptionId =
    typeof snapshot?.subscription?.id === "number"
      ? snapshot.subscription.id
      : null;
  const codeLabel = testCodes.find((code) => code.code === testCode)?.label;
  const withCode = (label: string) =>
    testCode ? `${label} (${codeLabel})` : label;

  return (
    <div className="space-y-4 border-2 border-dashed border-yellow-500 bg-card p-4">
      <div>
        <h2 className="flex items-center gap-2 text-lg font-bold">
          <FlaskConical size={18} />
          결제 실험실
          <Badge variant="outline">Toss 테스트 키</Badge>
        </h2>
        <p className="text-sm text-muted-foreground">
          cron·대사·환불·웹훅의 실제 코드를 지금 실행하고, Toss가 무엇을 답했고
          나루가 무엇을 바꿨는지 보여 줍니다. 모든 Toss 키가 테스트 키(test_…)일
          때만 나타납니다. 구독은 /support에서 Toss 테스트 카드로 먼저 만드세요.
        </p>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <label className="text-sm">
          <div className="mb-1 text-muted-foreground">계정</div>
          <select
            className="border-2 border-border bg-background px-2 py-1"
            value={userId ?? ""}
            onChange={(event) => selectAccount(event.target.value)}
          >
            <option value="">선택…</option>
            {accounts.map((account) => (
              <option key={account.userId} value={account.userId}>
                {account.loginName}
                {account.subscriptionStatus
                  ? ` · ${account.subscriptionStatus}`
                  : ""}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm">
          <div className="mb-1 text-muted-foreground">
            Toss 응답 (TossPayments-Test-Code)
          </div>
          <select
            className="border-2 border-border bg-background px-2 py-1"
            value={testCode}
            onChange={(event) => setTestCode(event.target.value)}
          >
            {testCodes.map((code) => (
              <option key={code.code} value={code.code}>
                {code.code ? `${code.code} — ${code.label}` : code.label}
              </option>
            ))}
          </select>
        </label>
        <Button
          variant="outline"
          size="sm"
          disabled={pending}
          onClick={() =>
            run("삭제 대기열 처리", { action: "process-key-queue", userId })
          }
        >
          빌링키 삭제 대기열 처리
        </Button>
      </div>

      {snapshot ? (
        <div className="space-y-3">
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              disabled={pending || !subscriptionId}
              onClick={() =>
                run(withCode("갱신 청구"), {
                  action: "charge",
                  subscriptionId,
                  testCode,
                })
              }
            >
              지금 갱신 청구
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={pending || !subscriptionId}
              onClick={() =>
                run("기간 종료로 이동", {
                  action: "advance",
                  subscriptionId,
                  to: "period_end",
                })
              }
            >
              기간을 지금 끝내기
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={pending || !subscriptionId}
              onClick={() =>
                run("유예 기간 지난 뒤로 이동", {
                  action: "advance",
                  subscriptionId,
                  to: "past_grace",
                })
              }
            >
              유예 기간 지난 뒤로
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={pending || !subscriptionId}
              onClick={() =>
                run("BILLING_DELETED", {
                  action: "billing-deleted",
                  subscriptionId,
                })
              }
            >
              Toss에서 빌링키 삭제 + BILLING_DELETED
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={pending || !userId}
              onClick={() => run("상태 보기", { action: "inspect", userId })}
            >
              새로고침
            </Button>
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <RecordDiff
              title="구독"
              before={snapshot.subscription}
              after={snapshot.subscription}
            />
            <RecordDiff
              title="계정"
              before={snapshot.user}
              after={snapshot.user}
            />
          </div>
          <PaymentsDiff
            before={snapshot.payments}
            after={snapshot.payments}
            actions={(payment) => (
              <span className="flex gap-1">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={pending}
                  onClick={() =>
                    run(withCode(`결제 ${payment.id} 대사`), {
                      action: "reconcile",
                      paymentId: payment.id,
                      testCode,
                    })
                  }
                >
                  대사
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={pending}
                  onClick={() =>
                    run(`결제 ${payment.id} 웹훅`, {
                      action: "payment-webhook",
                      paymentId: payment.id,
                    })
                  }
                >
                  웹훅
                </Button>
                {payment.status === "done" && !payment.refunded_amount ? (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={pending}
                    onClick={() =>
                      run(withCode(`결제 ${payment.id} 환불`), {
                        action: "refund",
                        paymentId: payment.id,
                        testCode,
                      })
                    }
                  >
                    환불
                  </Button>
                ) : null}
              </span>
            )}
          />
        </div>
      ) : null}

      {runs.map((entry) => (
        <div key={entry.id} className="space-y-3 border-2 border-border p-3">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={entry.result.ok ? "secondary" : "destructive"}>
              {entry.result.ok ? "완료" : "오류"}
            </Badge>
            <span className="font-semibold">{entry.label}</span>
            <span className="text-xs text-muted-foreground">
              {show(entry.at)}
            </span>
          </div>
          <div className="text-sm">{entry.result.message}</div>
          <div>
            <div className="mb-1 text-sm font-semibold">Toss API</div>
            <TossCalls calls={entry.result.calls} />
          </div>
          {entry.result.before && entry.result.after ? (
            <Fragment>
              <div className="grid gap-4 md:grid-cols-2">
                <RecordDiff
                  title="구독 (변경 전 → 후)"
                  before={entry.result.before.subscription}
                  after={entry.result.after.subscription}
                />
                <RecordDiff
                  title="계정 (변경 전 → 후)"
                  before={entry.result.before.user}
                  after={entry.result.after.user}
                />
              </div>
              <div>
                <div className="mb-1 text-sm font-semibold">
                  결제 원장 (새 행은 초록, 바뀐 칸은 노랑)
                </div>
                <PaymentsDiff
                  before={entry.result.before.payments}
                  after={entry.result.after.payments}
                />
              </div>
              <div>
                <div className="mb-1 text-sm font-semibold">
                  빌링키 삭제 대기열
                </div>
                <PaymentsDiff
                  before={entry.result.before.retiredKeys}
                  after={entry.result.after.retiredKeys}
                  columns={["id", "billing_key", "attempts", "last_error"]}
                  empty="비어 있음"
                />
              </div>
            </Fragment>
          ) : null}
        </div>
      ))}
    </div>
  );
}
