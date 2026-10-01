import type { Metadata } from "next";
import { maskSecret } from "@/lib/payments/toss";
import { db } from "@/lib/database";
import { STUCK_AFTER_ATTEMPTS } from "@/lib/payments/billing-keys";
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
import { requireOperator } from "../_components/requireOperator";

export const metadata: Metadata = { title: "빌링키 삭제 · 운영 · 나루" };

export default async function RetiredBillingKeysPage() {
  await requireOperator();

  const keys = await db
    .selectFrom("billing_keys")
    .select([
      "id",
      "billing_key",
      "retired_at",
      "delete_attempts as attempts",
      "delete_last_attempted_at as last_attempted_at",
      "delete_last_error as last_error",
    ])
    .where("status", "=", "retired")
    .orderBy("delete_attempts", "desc")
    .orderBy("retired_at", "asc")
    .execute();

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h2 className="text-xl font-bold">빌링키 삭제 대기</h2>
        <p className="text-sm text-muted-foreground">
          더 쓰지 않게 됐지만 Toss에서 아직 지우지 못한 빌링키입니다. 5분마다
          다시 시도하고, 실패하면 한 시간부터 두 배씩(최대 하루) 간격을
          늘립니다. Toss가 삭제를 확인하면 암호화된 키를 지우고 목록에서
          빠집니다. {keys.length}개.
        </p>
      </div>

      <div className="overflow-x-auto border-2 border-border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>빌링키</TableHead>
              <TableHead>폐기</TableHead>
              <TableHead>시도</TableHead>
              <TableHead>마지막 시도</TableHead>
              <TableHead>마지막 오류</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {keys.map((key) => (
              <TableRow key={key.id}>
                <TableCell className="font-mono text-xs">
                  {maskSecret(key.billing_key ?? "")}
                </TableCell>
                <TableCell className="whitespace-nowrap">
                  {formatDate(key.retired_at)}
                </TableCell>
                <TableCell>
                  {key.attempts >= STUCK_AFTER_ATTEMPTS ? (
                    <Badge variant="destructive">{key.attempts}</Badge>
                  ) : (
                    key.attempts
                  )}
                </TableCell>
                <TableCell className="whitespace-nowrap">
                  {formatDate(key.last_attempted_at)}
                </TableCell>
                <TableCell className="max-w-xl break-words">
                  {key.last_error ?? "-"}
                </TableCell>
              </TableRow>
            ))}
            {keys.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={5}
                  className="py-10 text-center text-muted-foreground"
                >
                  삭제를 기다리는 빌링키가 없습니다.
                </TableCell>
              </TableRow>
            ) : null}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
