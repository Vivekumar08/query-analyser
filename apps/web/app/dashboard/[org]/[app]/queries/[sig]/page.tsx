import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import { getQuery, getSeries } from '@/src/dashboard-api';
import { getShellContext } from '@/src/shell-context';
import { parseRange, rangeToParams, rangeToWindow } from '@/src/range';
import { formatCount, formatMs } from '@/src/format';
import { histogramData, trendData } from '@/src/detail-view';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { PageHeader } from '@/components/dashboard/PageHeader';
import { RangeControl } from '@/components/dashboard/RangeControl';
import { Percentile } from '@/components/dashboard/Percentile';
import { StatCard } from '@/components/dashboard/StatCard';
import { HistogramChart } from '@/components/dashboard/HistogramChart';
import { TrendChart } from '@/components/dashboard/TrendChart';
import { AdviceCard } from '@/components/dashboard/AdviceCard';
import { CopyButton } from '@/components/dashboard/CopyButton';

const COPY_CLASS = 'rounded-md border px-3 py-1 text-xs text-muted-foreground hover:bg-muted';

function rangeLabel(r: ReturnType<typeof parseRange>): string {
  return r.kind === 'preset' ? `last ${r.preset}` : `${r.from.slice(0, 10)} – ${r.to.slice(0, 10)}`;
}

export default async function QueryDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ org: string; app: string; sig: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { org, app, sig } = await params;
  const range = parseRange(await searchParams);
  const rangeQs = new URLSearchParams(rangeToParams(range)).toString();
  const base = `/dashboard/${encodeURIComponent(org)}/${encodeURIComponent(app)}`;
  const listHref = `${base}/queries${rangeQs ? `?${rangeQs}` : ''}`;
  const self = `${base}/queries/${encodeURIComponent(sig)}${rangeQs ? `?${rangeQs}` : ''}`;
  // Authorises the org↔app pairing; the app ID (not the URL value) goes to the API.
  const ctx = await getShellContext(org, app);
  const token = ctx.session.accessToken;
  const appId = ctx.app.id;

  // Detail is all-time (the API ignores a window); only the trend is range-scoped.
  const [detail, series] = await Promise.all([
    getQuery(token, appId, sig),
    getSeries(token, appId, sig, rangeToWindow(range)),
  ]);
  if (!detail.ok) {
    if (detail.status === 401) redirect(`/api/auth/refresh?next=${encodeURIComponent(self)}`);
    if (detail.status === 404 || detail.status === 403) notFound();
    throw new Error('Could not load query');
  }
  const d = detail.data;
  const title = `${d.model}.${d.operation}`;

  return (
    <>
      <PageHeader
        title={title}
        crumbs={[{ label: org }, { label: 'Queries', href: listHref }, { label: title }]}
        actions={<RangeControl value={range} />}
      />
      <div className="flex flex-col gap-6 p-6">
        <Link href={listHref} className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="size-4" /> All queries
        </Link>
        <div className="flex items-start gap-2">
          <pre className="flex-1 overflow-x-auto rounded-lg border bg-muted p-4 font-mono text-sm"><code>{d.signature}</code></pre>
          <CopyButton text={d.signature} label="Copy the query signature" className={COPY_CLASS} />
        </div>
        <p className="text-xs text-muted-foreground">First seen {new Date(d.firstSeen).toUTCString()} · last seen {new Date(d.lastSeen).toUTCString()}</p>

        <section aria-label="All-time stats" className="flex flex-col gap-2">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">All time</p>
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            <StatCard label="Calls">{formatCount(d.count)}</StatCard>
            <StatCard label="Time wasted">{formatMs(d.totalMs)}</StatCard>
            <StatCard label="p95" hint={<Percentile label="p99" value={d.p99} />}><Percentile label="p95" showLabel={false} value={d.p95} /></StatCard>
            <StatCard label="Max">{formatMs(d.maxMs)}</StatCard>
          </div>
        </section>

        <div className="grid gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader><CardTitle className="text-base">Latency distribution <span className="ml-1 text-xs font-normal text-muted-foreground">All time</span></CardTitle></CardHeader>
            <CardContent><HistogramChart data={histogramData(d.hist)} /></CardContent>
          </Card>
          <Card>
            <CardHeader><CardTitle className="text-base">Trend · {rangeLabel(range)}</CardTitle></CardHeader>
            <CardContent>
              {series.ok && series.data.points.length > 0
                ? <TrendChart data={trendData(series.data.points, series.data.grain)} />
                : <p className="py-16 text-center text-sm text-muted-foreground">No trend data in this window.</p>}
            </CardContent>
          </Card>
        </div>

        <AdviceCard appId={appId} model={d.model} advice={d.advice} />

        {d.redactedSample != null && (
          <Card>
            <CardHeader><CardTitle className="text-base">Redacted sample <span className="ml-1 text-xs font-normal text-muted-foreground">All time</span></CardTitle></CardHeader>
            <CardContent className="flex flex-col gap-2">
              <pre className="overflow-x-auto rounded-md border bg-muted p-3 font-mono text-xs"><code>{JSON.stringify(d.redactedSample, null, 2)}</code></pre>
              <p className="text-xs text-muted-foreground">Values are never sent — shapes only.</p>
            </CardContent>
          </Card>
        )}
      </div>
    </>
  );
}
