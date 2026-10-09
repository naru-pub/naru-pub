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

interface TopPageData {
  path: string;
  views: number;
  uniqueVisitors: number;
}

interface TopPagesTableProps {
  data: TopPageData[];
}

export default function TopPagesTable({ data }: TopPagesTableProps) {
  return (
    <Card className="bg-card border-2 border-line">
      <CardHeader className="border-b border-border">
        <CardTitle className="text-foreground">인기 페이지</CardTitle>
        <CardDescription className="text-muted-foreground">
          최근 30일 기준 가장 많이 방문된 페이지
        </CardDescription>
      </CardHeader>
      <CardContent className="pt-6">
        {data.length === 0 ? (
          <p className="text-muted-foreground text-center py-8">
            아직 페이지뷰 데이터가 없습니다.
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="text-foreground">경로</TableHead>
                <TableHead className="text-foreground text-right">
                  페이지뷰
                </TableHead>
                <TableHead className="text-foreground text-right">
                  순방문자
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.map((page) => (
                <TableRow key={page.path}>
                  <TableCell className="font-mono text-sm">
                    {page.path}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{page.views}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {page.uniqueVisitors}
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
