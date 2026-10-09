import type { Metadata } from "next";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  isMetricKey,
  METRICS,
  NEAR_LIMIT,
  readUsage,
  type MetricKey,
} from "../_components/usage";
import { requireOperator } from "../_components/requireOperator";

export const metadata: Metadata = { title: "사용량 · 운영 · 나루" };

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unit]}`;
}

function formatValue(value: number, unit: "bytes" | "count"): string {
  return unit === "bytes"
    ? formatBytes(value)
    : new Intl.NumberFormat("ko-KR").format(value);
}

export default async function UsagePage({
  searchParams,
}: {
  searchParams: Promise<{ sort?: string }>;
}) {
  await requireOperator();
  const { sort: sortParam } = await searchParams;
  const sort: MetricKey = isMetricKey(sortParam) ? sortParam : "storage_bytes";
  const sortMetric = METRICS.find((metric) => metric.key === sort)!;
  const now = new Date();

  const { stat, top } = await readUsage(now, sort);

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h2 className="text-xl font-bold">사용량</h2>
        <p className="text-sm text-muted-foreground">
          삭제되지 않은 계정 {stat("accounts")}개 (유료 이용{" "}
          {stat("supporters")}
          개)의 사용량입니다. 제한이 있는 항목은 제한의{" "}
          {Math.round(NEAR_LIMIT * 100)}% 이상을 쓰는 계정 수를 함께 셉니다.
          사이트 파일 용량은 주기적으로 측정한 값이고 제한이 없습니다.
        </p>
      </div>

      <div className="overflow-x-auto border-2 border-border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>항목</TableHead>
              <TableHead className="text-right">쓰는 계정</TableHead>
              <TableHead className="text-right">중앙값</TableHead>
              <TableHead className="text-right">상위 10%</TableHead>
              <TableHead className="text-right">상위 1%</TableHead>
              <TableHead className="text-right">최대</TableHead>
              <TableHead className="text-right">제한</TableHead>
              <TableHead className="text-right">제한 근접</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {METRICS.map((metric) => (
              <TableRow key={metric.key}>
                <TableCell className="font-medium">
                  <Link
                    href={`/admin/usage?sort=${metric.key}`}
                    className="underline"
                  >
                    {metric.label}
                  </Link>
                </TableCell>
                <TableCell className="text-right">
                  {stat(`${metric.key}__used`)}
                </TableCell>
                {(["p50", "p90", "p99", "max"] as const).map((suffix) => (
                  <TableCell
                    key={suffix}
                    className="whitespace-nowrap text-right"
                  >
                    {formatValue(stat(`${metric.key}__${suffix}`), metric.unit)}
                  </TableCell>
                ))}
                <TableCell className="whitespace-nowrap text-right">
                  {metric.limit === null
                    ? "-"
                    : formatValue(metric.limit, metric.unit)}
                </TableCell>
                <TableCell className="text-right">
                  {metric.limit === null ? (
                    "-"
                  ) : stat(`${metric.key}__near`) > 0 ? (
                    <Badge variant="destructive">
                      {stat(`${metric.key}__near`)}
                    </Badge>
                  ) : (
                    0
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <div className="flex flex-wrap gap-2 text-sm">
        {METRICS.map((metric) => (
          <Link
            key={metric.key}
            href={`/admin/usage?sort=${metric.key}`}
            className={`border-2 px-3 py-1 ${sort === metric.key ? "border-primary font-bold" : "border-border text-muted-foreground"}`}
          >
            {metric.label}
          </Link>
        ))}
      </div>

      <div className="space-y-2">
        <h3 className="font-bold">{sortMetric.label} 상위 100개 계정</h3>
        <div className="overflow-x-auto border-2 border-border bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>계정</TableHead>
                <TableHead>이용</TableHead>
                {METRICS.map((metric) => (
                  <TableHead
                    key={metric.key}
                    className={`whitespace-nowrap text-right ${metric.key === sort ? "font-bold text-foreground" : ""}`}
                  >
                    {metric.label}
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {top.map((row) => (
                <TableRow key={row.id}>
                  <TableCell className="font-medium">
                    <Link
                      href={`/admin/events?user=${encodeURIComponent(row.login_name)}`}
                      className="underline"
                    >
                      {row.login_name}
                    </Link>
                  </TableCell>
                  <TableCell>
                    {row.supporter_comp ? (
                      <Badge variant="secondary">무료 제공</Badge>
                    ) : row.supporter ? (
                      <Badge variant="outline">유료</Badge>
                    ) : (
                      <span className="text-muted-foreground">무료</span>
                    )}
                  </TableCell>
                  {METRICS.map((metric) => {
                    const value = Number(row[metric.key]);
                    const near =
                      metric.limit !== null &&
                      value >= metric.limit * NEAR_LIMIT;
                    return (
                      <TableCell
                        key={metric.key}
                        className={`whitespace-nowrap text-right ${near ? "font-bold text-destructive" : ""}`}
                      >
                        {formatValue(value, metric.unit)}
                        {metric.limit !== null && value > 0 ? (
                          <span className="ml-1 text-xs text-muted-foreground">
                            {Math.round((value / metric.limit) * 100)}%
                          </span>
                        ) : null}
                      </TableCell>
                    );
                  })}
                </TableRow>
              ))}
              {top.length === 0 ? (
                <TableRow>
                  <TableCell
                    colSpan={METRICS.length + 2}
                    className="py-10 text-center text-muted-foreground"
                  >
                    계정이 없습니다.
                  </TableCell>
                </TableRow>
              ) : null}
            </TableBody>
          </Table>
        </div>
      </div>
    </div>
  );
}
