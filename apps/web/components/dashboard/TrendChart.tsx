'use client';
import { CartesianGrid, Line, LineChart, XAxis, YAxis } from 'recharts';
import { formatMs } from '@/src/format';
import { trendValueText } from '@/src/detail-view';
import { ChartContainer, ChartLegend, ChartLegendContent, ChartTooltip, ChartTooltipContent, type ChartConfig } from '@/components/ui/chart';

const config = {
  calls: { label: 'Calls', color: 'var(--chart-2)' },
  p95: { label: 'p95', color: 'var(--chart-1)' },
  errors: { label: 'Errors', color: 'var(--destructive)' },
} satisfies ChartConfig;

export function TrendChart({ data }: { data: { label: string; calls: number; p95: number | null; p95Basis: 'interpolated' | 'floor' | null; errors?: number | null }[] }) {
  const hasErrors = data.some((p) => (p.errors ?? 0) > 0);
  return (
    <ChartContainer config={config} className="h-56 w-full">
      <LineChart data={data} margin={{ left: 0, right: 8 }}>
        <CartesianGrid vertical={false} />
        <XAxis dataKey="label" tickLine={false} axisLine={false} fontSize={11} minTickGap={24} />
        <YAxis yAxisId="calls" allowDecimals={false} tickLine={false} axisLine={false} width={32} fontSize={11} />
        <YAxis yAxisId="p95" orientation="right" tickLine={false} axisLine={false} width={48} fontSize={11} tickFormatter={(v: number) => formatMs(v)} />
        <ChartTooltip content={<ChartTooltipContent
          formatter={(value, name, item) => (
            <div className="flex w-full items-center justify-between gap-4">
              <span className="flex items-center gap-1.5 text-muted-foreground">
                <span className="h-2 w-2 rounded-[2px]" style={{ background: `var(--color-${String(name)})` }} />
                {config[name as 'calls' | 'p95' | 'errors']?.label ?? name}
              </span>
              <span className="font-mono font-medium tabular-nums">
                {trendValueText(name === 'p95' ? 'p95' : 'calls', Number(value), name === 'p95' ? (item.payload as { p95Basis: 'interpolated' | 'floor' | null }).p95Basis : null)}
              </span>
            </div>
          )}
        />} />
        <ChartLegend content={<ChartLegendContent />} />
        <Line yAxisId="calls" dataKey="calls" stroke="var(--color-calls)" strokeWidth={2} dot={false} />
        <Line yAxisId="p95" dataKey="p95" stroke="var(--color-p95)" strokeWidth={2} dot={false} connectNulls={false} />
        {hasErrors && <Line yAxisId="calls" dataKey="errors" stroke="var(--color-errors)" strokeWidth={2} dot={false} connectNulls={false} />}
      </LineChart>
    </ChartContainer>
  );
}
