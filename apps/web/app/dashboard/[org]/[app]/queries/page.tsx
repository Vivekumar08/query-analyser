import Link from 'next/link';
import { listQueries } from '@/src/dashboard-api';
import { getShellContext } from '@/src/shell-context';
import { filtersToApiQuery, filtersToSearch, parseFilters, PAGE_SIZE } from '@/src/filters';
import { clearFiltersHref, emptyKind, toRowsView } from '@/src/queries-view';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { PageHeader } from '@/components/dashboard/PageHeader';
import { RangeControl } from '@/components/dashboard/RangeControl';
import { QueryFiltersBar } from '@/components/dashboard/QueryFilters';
import { QueriesTable } from '@/components/dashboard/QueriesTable';
import { QueriesEmpty } from '@/components/dashboard/EmptyState';

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

  const res = await listQueries(ctx.session.accessToken, ctx.app.id, filtersToApiQuery(filters));
  if (!res.ok) throw new Error('Could not load queries');
  const { items, sortExact, sortNote } = res.data;
  const rows = toRowsView(items);
  const filtered = filters.models.length > 0 || filters.ops.length > 0;
  const kind = emptyKind({ rows: rows.length, filtered });
  const models = [...new Set([...items.map((r) => r.model), ...filters.models])].sort();
  const ops = [...new Set([...items.map((r) => r.operation), ...filters.ops])].sort();
  const more = new URLSearchParams(search);
  more.set('limit', String(filters.limit + PAGE_SIZE));

  return (
    <>
      <PageHeader title="Queries" crumbs={[{ label: org }, { label: 'Queries' }]} actions={<RangeControl value={filters.range} />} />
      <div className="flex flex-col gap-4 p-6">
        <QueryFiltersBar models={models} ops={ops} value={filters} />
        {(!sortExact || sortNote) && (
          <p className="text-xs text-muted-foreground">{sortNote ?? 'Ordering by this column is approximate.'}</p>
        )}
        {kind === 'none' ? (
          <Card className="overflow-hidden p-0">
            <QueriesTable base={base} search={search} rows={rows} />
          </Card>
        ) : (
          <QueriesEmpty kind={kind} clearHref={clearFiltersHref(base, filters)} installHref={INSTALL_HREF} />
        )}
        {rows.length === filters.limit && (
          <Button asChild variant="outline" className="self-center">
            <Link href={`${base}/queries?${more.toString()}`} scroll={false}>Show more</Link>
          </Button>
        )}
      </div>
    </>
  );
}
