import Link from 'next/link';
import { redirect } from 'next/navigation';
import { listQueries } from '@/src/dashboard-api';
import { getShellContext } from '@/src/shell-context';
import { filtersToApiQuery, filtersToSearch, parseFilters, PAGE_SIZE } from '@/src/filters';
import { clearFiltersHref, emptyKind, listOutcome, toRowsView } from '@/src/queries-view';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { PageHeader } from '@/components/dashboard/PageHeader';
import { RangeControl } from '@/components/dashboard/RangeControl';
import { QueryFiltersBar } from '@/components/dashboard/QueryFilters';
import { QueriesTable } from '@/components/dashboard/QueriesTable';
import { QueriesEmpty } from '@/components/dashboard/EmptyState';
import { FadeIn } from '@/components/dashboard/FadeIn';

const INSTALL_HREF = 'https://www.npmjs.com/package/@vivekumar08/query-analyser';

export default async function QueriesPage({
  params,
  searchParams,
}: {
  params: Promise<{ org: string; app: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { org, app } = await params;
  const sp = await searchParams;
  // Authorises the org↔app pairing; the app ID (not the URL value) goes to the API.
  const ctx = await getShellContext(org, app);
  const base = `/dashboard/${encodeURIComponent(org)}/${encodeURIComponent(app)}`;
  const filters = parseFilters(sp);
  const search = filtersToSearch(filters);

  const token = ctx.session.accessToken;
  const res = await listQueries(token, ctx.app.id, filtersToApiQuery(filters));
  if (!res.ok && res.status === 401) redirect(`/api/auth/refresh?next=${encodeURIComponent(`${base}/queries${search ? `?${search}` : ''}`)}`);
  const outcome = listOutcome(res);
  if (outcome === 'error') throw new Error('Could not load queries');

  const filtered = filters.model !== undefined || filters.op !== undefined;
  const { items, sortExact, sortNote } = res.ok ? res.data : { items: [], sortExact: true, sortNote: undefined };
  const rows = toRowsView(items);
  const kind = emptyKind({ rows: rows.length, filtered });

  // Options come from the unfiltered window; with a filter active the current
  // rows are all one model/op, so one extra unfiltered call supplies the rest.
  let optionRows = items;
  if (filtered) {
    const all = await listQueries(token, ctx.app.id, filtersToApiQuery({ range: filters.range, sort: 'wasted', limit: 500 }));
    if (all.ok) optionRows = all.data.items;
  }
  const models = [...new Set([...optionRows.map((r) => r.model), ...(filters.model ? [filters.model] : [])])].sort();
  const ops = [...new Set([...optionRows.map((r) => r.operation), ...(filters.op ? [filters.op] : [])])].sort();
  const more = new URLSearchParams(search);
  more.set('limit', String(filters.limit + PAGE_SIZE));

  return (
    <>
      <PageHeader title="Queries" crumbs={[{ label: org }, { label: 'Queries' }]} actions={<RangeControl value={filters.range} />} />
      <FadeIn>
      <div className="flex flex-col gap-4 p-6">
        <QueryFiltersBar models={models} ops={ops} value={filters} />
        {(!sortExact || sortNote) && (
          <p className="text-xs text-muted-foreground">{sortNote ?? 'Ordering by this column is approximate.'}</p>
        )}
        {outcome === 'invalid-filters' ? (
          <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed px-6 py-16 text-center">
            <p className="font-medium">These filters aren&apos;t valid.</p>
            <Button asChild variant="outline"><Link href={clearFiltersHref(base, filters)}>Clear filters</Link></Button>
          </div>
        ) : kind === 'none' ? (
          <Card className="overflow-hidden p-0">
            <QueriesTable base={base} search={search} rows={rows} />
          </Card>
        ) : (
          <QueriesEmpty kind={kind} clearHref={clearFiltersHref(base, filters)} installHref={INSTALL_HREF} />
        )}
        {outcome === 'ok' && rows.length === filters.limit && (
          <Button asChild variant="outline" className="self-center">
            <Link href={`${base}/queries?${more.toString()}`} scroll={false}>Show more</Link>
          </Button>
        )}
      </div>
      </FadeIn>
    </>
  );
}
