import { FINE_HIST_BOUNDS } from '@query-analyser/contract/runtime';
import type { QueryDetail, SeriesResponse } from '@/src/dashboard-types';
import { histogramData, trendData } from '@/src/detail-view';
import { formatMs } from '@/src/format';
import { ormLabel, sampledLabel } from '@/src/sources';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { StatCard } from './StatCard';
import { Percentile } from './Percentile';
import { CountUp } from './CountUp';
import { CopyButton } from './CopyButton';
import { HistogramChart } from './HistogramChart';
import { TrendChart } from './TrendChart';

const COPY_CLASS = 'rounded-md border px-3 py-1 text-xs text-muted-foreground hover:bg-muted';

/** The SQL detail view: no Compass card and no index advice (those are MongoDB only). */
export function SqlQueryDetail({ detail: d, series, rangeLabel }: { detail: QueryDetail; series: SeriesResponse | null; rangeLabel: string }) {
  const sql = d.sqlText ?? d.signature;
  const estimated = d.sampled ? sampledLabel(d.sampleRate) : null;
  const fine = d.histFine ?? null;
  const histData = fine ? histogramData(fine, FINE_HIST_BOUNDS) : histogramData(d.hist);
  const meta: [string, string][] = [
    ['Database', d.database ?? '—'],
    ['Table', d.collection ?? '—'],
    ['ORM', ormLabel(d.source, d.orm)],
    ['Operation', `${d.model}.${d.operation}`],
  ];
  return (
    <div className="flex flex-col gap-6 p-6">
      <div className="flex items-start gap-2">
        <pre className="flex-1 overflow-x-auto whitespace-pre-wrap break-words rounded-lg border bg-muted p-4 font-mono text-sm"><code>{sql}</code></pre>
        <CopyButton text={sql} label="Copy the SQL" className={COPY_CLASS} />
      </div>
      <p className="text-xs text-muted-foreground">First seen {new Date(d.firstSeen).toUTCString()} · last seen {new Date(d.lastSeen).toUTCString()}</p>

      <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm lg:grid-cols-4">
        {meta.map(([k, v]) => (
          <div key={k} className="flex flex-col">
            <dt className="text-xs uppercase tracking-wide text-muted-foreground">{k}</dt>
            <dd className="font-mono">{v}</dd>
          </div>
        ))}
      </dl>

      <section aria-label="All-time stats" className="flex flex-col gap-2">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">All time</p>
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          <StatCard label="Calls"><CountUp value={d.count} kind="count" /></StatCard>
          <StatCard label="Total time">{formatMs(d.totalMs)}</StatCard>
          <StatCard label="Avg">{formatMs(d.avgMs)}</StatCard>
          <StatCard label="P50"><Percentile label="P50" showLabel={false} value={d.p50 ?? null} /></StatCard>
          <StatCard label="P95"><Percentile label="P95" showLabel={false} value={d.p95} /></StatCard>
          <StatCard label="P99"><Percentile label="P99" showLabel={false} value={d.p99} /></StatCard>
          <StatCard label="Max"><CountUp value={d.maxMs} kind="ms" /></StatCard>
          <StatCard label="Errors" hint={d.lastErrorCode ? `last SQLSTATE ${d.lastErrorCode}` : undefined}>
            <CountUp value={d.errors ?? 0} kind="count" />
          </StatCard>
        </div>
        {estimated && <p className="text-xs text-muted-foreground">{estimated}</p>}
        {d.thresholdMs != null && (
          <p className="text-xs text-muted-foreground">Slow threshold {formatMs(d.thresholdMs)}{fine ? '' : ': latency distribution counts slow statements only'}</p>
        )}
      </section>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader><CardTitle className="text-base">Latency distribution <span className="ml-1 text-xs font-normal text-muted-foreground">All time</span></CardTitle></CardHeader>
          <CardContent><HistogramChart data={histData} /></CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle className="text-base">Trend · {rangeLabel}</CardTitle></CardHeader>
          <CardContent>
            {series && series.points.length > 0
              ? <TrendChart data={trendData(series.points, series.grain)} />
              : <p className="py-16 text-center text-sm text-muted-foreground">No trend data in this window.</p>}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
