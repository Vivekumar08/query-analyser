import { StatCard } from '@/components/dashboard/StatCard';
import { Percentile } from '@/components/dashboard/Percentile';
import { formatCount, formatMs } from '@/src/format';
import { sampledLabel, sourceLabel } from '@/src/sources';
import type { SourceSummary, SummaryResponse } from '@/src/dashboard-types';

function Group({ s, threshold }: { s: SourceSummary; threshold: string }) {
  const sampled = s.sampled ? sampledLabel(s.sampleRate) : null;
  const label = sampled ? `${sourceLabel(s.source)} · ${sampled}` : sourceLabel(s.source);
  const slowOnly = s.counts === 'slow-only';
  return (
    <section aria-label={label} className="flex flex-col gap-2">
      <h2 className="text-sm font-medium text-muted-foreground">{label}</h2>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-7">
        {slowOnly ? (
          <>
            <StatCard label={`Slow queries (≥ ${threshold})`}>{formatCount(s.count)}</StatCard>
            <StatCard label="Avg">{formatMs(s.avgMs)}</StatCard>
            <StatCard label="P95"><Percentile label="P95" value={s.p95} showLabel={false} /></StatCard>
          </>
        ) : (
          <>
            <StatCard label="Statements">{formatCount(s.count)}</StatCard>
            <StatCard label="Avg">{formatMs(s.avgMs)}</StatCard>
            <StatCard label="P50"><Percentile label="P50" value={s.p50} showLabel={false} /></StatCard>
            <StatCard label="P95"><Percentile label="P95" value={s.p95} showLabel={false} /></StatCard>
            <StatCard label="P99"><Percentile label="P99" value={s.p99} showLabel={false} /></StatCard>
            <StatCard label={`Slow (≥ ${threshold})`}>{formatCount(s.slowCount)}</StatCard>
            <StatCard label="Errors">{formatCount(s.errors)}</StatCard>
          </>
        )}
      </div>
    </section>
  );
}

/**
 * One group per source, side by side. MongoDB figures are slow queries only
 * and SQL figures are every statement, so no combined total is ever shown.
 */
export function SummaryStrip({ summary }: { summary: SummaryResponse }) {
  const threshold = summary.thresholdMs === null ? 'threshold' : `${summary.thresholdMs} ms`;
  const n = summary.droppedNew;
  return (
    <div className="flex flex-col gap-4">
      {summary.droppedNew > 0 && (
        <p role="status" className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100">
          {`Some new query shapes were not recorded in this window (${n} ${n === 1 ? 'drop' : 'drops'}) because this app reached its 5,000-shape limit. Queries already seen are still counted.`}
        </p>
      )}
      {summary.sources.map((s) => (
        <Group key={s.source} s={s} threshold={threshold} />
      ))}
    </div>
  );
}
