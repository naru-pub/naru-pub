"use client";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

interface TopReferrerData {
  referrer: string;
  views: number;
}

interface TopReferrersTableProps {
  data: TopReferrerData[];
}

export default function TopReferrersTable({ data }: TopReferrersTableProps) {
  return (
    <Card className="bg-card border-2 border-line">
      <CardHeader className="border-b border-border">
        <CardTitle className="text-foreground">유입 경로</CardTitle>
        <CardDescription className="text-muted-foreground">
          최근 30일 기준 상위 유입 경로
        </CardDescription>
      </CardHeader>
      <CardContent className="pt-6">
        {data.length === 0 ? (
          <p className="text-muted-foreground text-center py-8">
            아직 유입 경로 데이터가 없습니다.
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="text-foreground">유입 경로</TableHead>
                <TableHead className="text-foreground text-right">
                  페이지뷰
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.map((referrer) => (
                <TableRow key={referrer.referrer}>
                  <TableCell className="font-mono text-sm">
                    {referrer.referrer}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {referrer.views}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
