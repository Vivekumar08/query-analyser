import type { QueryDetail } from '@/src/dashboard-types';
import { formatMs } from '@/src/format';
import { StatCard } from './StatCard';
import { Percentile } from './Percentile';
import { CountUp } from './CountUp';

/** The all-time stat row on the query detail page. SQL percentiles can be null (rendered as a dash). */
export function AllTimeStats({ d }: { d: Pick<QueryDetail, 'count' | 'totalMs' | 'maxMs' | 'p95' | 'p99'> }) {
  return (
    <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
      <StatCard label="Calls"><CountUp value={d.count} kind="count" /></StatCard>
      <StatCard label="Time wasted">{formatMs(d.totalMs)}</StatCard>
      <StatCard label="p95" hint={<Percentile label="p99" value={d.p99} />}><Percentile label="p95" showLabel={false} value={d.p95} /></StatCard>
      <StatCard label="Max"><CountUp value={d.maxMs} kind="ms" /></StatCard>
    </div>
  );
}
