"use client";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

interface HomeDirectorySizeData {
  sizeBytes: number;
}

interface HistogramData {
  range: string;
  count: number;
  minSize: number;
  maxSize: number;
}

interface HomeDirectorySizeDistributionChartProps {
  data: HomeDirectorySizeData[];
}

function createHistogramData(
  data: HomeDirectorySizeData[],
  numBins: number = 10
): HistogramData[] {
  if (data.length === 0) return [];

  const sizes = data.map((d) => d.sizeBytes).filter((size) => size > 0);
  if (sizes.length === 0) return [];

  const minSize = Math.min(...sizes);
  const maxSize = Math.max(...sizes);

  // Use log scale for better distribution visualization
  const logMin = Math.log10(minSize);
  const logMax = Math.log10(maxSize);
  const binWidth = (logMax - logMin) / numBins;

  const bins: number[] = new Array(numBins).fill(0);
  const binRanges: { min: number; max: number }[] = [];

  // Create bin ranges
  for (let i = 0; i < numBins; i++) {
    const binMin = Math.pow(10, logMin + i * binWidth);
    const binMax = Math.pow(10, logMin + (i + 1) * binWidth);
    binRanges.push({ min: binMin, max: binMax });
  }

  // Count data points in each bin
  sizes.forEach((size) => {
    for (let i = 0; i < numBins; i++) {
      if (size >= binRanges[i].min && size < binRanges[i].max) {
        bins[i]++;
        break;
      }
    }
  });

  // Convert to chart data format
  return binRanges.map((range, index) => ({
    range: `${formatBytes(range.min)} - ${formatBytes(range.max)}`,
    count: bins[index],
    minSize: range.min,
    maxSize: range.max,
  }));
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
}

export default function HomeDirectorySizeDistributionChart({
  data,
}: HomeDirectorySizeDistributionChartProps) {
  const histogramData = createHistogramData(data);

  return (
    <Card className="bg-card border-2 border-line">
      <CardHeader className="border-b border-border">
        <CardTitle className="text-foreground">홈 디렉토리 크기 분포</CardTitle>
        <CardDescription className="text-muted-foreground">
          사용자별 홈 디렉토리 크기 분포 히스토그램
        </CardDescription>
      </CardHeader>
      <CardContent className="pt-6">
        <ResponsiveContainer width="100%" height={400}>
          <BarChart data={histogramData}>
            <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--muted-foreground))" opacity={0.2} />
            <XAxis
              dataKey="range"
              stroke="hsl(var(--muted-foreground))"
              fontSize={10}
              tickLine={false}
              axisLine={false}
              angle={-45}
              textAnchor="end"
              height={80}
            />
            <YAxis
              stroke="hsl(var(--muted-foreground))"
              fontSize={12}
              tickLine={false}
              axisLine={false}
              tickFormatter={(value) => (value === 0 ? "" : `${value}명`)}
            />
            <Tooltip
              content={({ active, payload, label }) => {
                if (active && payload && payload.length) {
                  const data = payload[0].payload as HistogramData;
                  return (
                    <div className="rounded-lg border bg-background p-2">
                      <div className="grid grid-cols-2 gap-2">
                        <div className="flex flex-col">
                          <span className="text-[0.70rem] uppercase text-muted-foreground">
                            크기 범위
                          </span>
                          <span className="font-bold text-muted-foreground">
                            {label}
                          </span>
                        </div>
                        <div className="flex flex-col">
                          <span className="text-[0.70rem] uppercase text-muted-foreground">
                            사용자 수
                          </span>
                          <span className="font-bold">
                            {payload[0].value}명
                          </span>
                        </div>
                      </div>
                    </div>
                  );
                }
                return null;
              }}
            />
            <Bar dataKey="count" fill="hsl(var(--primary))" radius={[4, 4, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </CardContent>
    </Card>
  );
}
