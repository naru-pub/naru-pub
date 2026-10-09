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

interface UserAgentData {
  userAgent: string;
  views: number;
}

interface UserAgentsTableProps {
  data: UserAgentData[];
}

export default function UserAgentsTable({ data }: UserAgentsTableProps) {
  return (
    <Card className="bg-card border-2 border-line">
      <CardHeader className="border-b border-border">
        <CardTitle className="text-foreground">브라우저</CardTitle>
        <CardDescription className="text-muted-foreground">
          최근 30일 기준 브라우저별 방문 현황
        </CardDescription>
      </CardHeader>
      <CardContent className="pt-6">
        {data.length === 0 ? (
          <p className="text-muted-foreground text-center py-8">
            아직 브라우저 데이터가 없습니다.
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="text-foreground">브라우저</TableHead>
                <TableHead className="text-foreground text-right">
                  페이지뷰
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.map((entry) => (
                <TableRow key={entry.userAgent}>
                  <TableCell className="font-mono text-sm">
                    {entry.userAgent}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{entry.views}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
