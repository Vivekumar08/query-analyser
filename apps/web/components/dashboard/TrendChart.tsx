'use client';
import { CartesianGrid, Line, LineChart, XAxis, YAxis } from 'recharts';
import { ChartContainer, ChartLegend, ChartLegendContent, ChartTooltip, ChartTooltipContent, type ChartConfig } from '@/components/ui/chart';

const config = {
  calls: { label: 'Calls', color: 'var(--chart-2)' },
  p95: { label: 'p95 (ms)', color: 'var(--chart-1)' },
} satisfies ChartConfig;

export function TrendChart({ data }: { data: { label: string; calls: number; p95: number | null }[] }) {
  return (
    <ChartContainer config={config} className="h-56 w-full">
      <LineChart data={data} margin={{ left: 0, right: 8 }}>
        <CartesianGrid vertical={false} />
        <XAxis dataKey="label" tickLine={false} axisLine={false} fontSize={11} minTickGap={24} />
        <YAxis yAxisId="calls" allowDecimals={false} tickLine={false} axisLine={false} width={32} fontSize={11} />
        <YAxis yAxisId="p95" orientation="right" tickLine={false} axisLine={false} width={40} fontSize={11} />
        <ChartTooltip content={<ChartTooltipContent />} />
        <ChartLegend content={<ChartLegendContent />} />
        <Line yAxisId="calls" dataKey="calls" stroke="var(--color-calls)" strokeWidth={2} dot={false} />
        <Line yAxisId="p95" dataKey="p95" stroke="var(--color-p95)" strokeWidth={2} dot={false} connectNulls={false} />
      </LineChart>
    </ChartContainer>
  );
}
