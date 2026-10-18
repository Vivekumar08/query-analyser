import Link from 'next/link';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import type { RowView } from '@/src/queries-view';
import { formatCount } from '@/src/format';
import { Percentile } from './Percentile';

export function QueriesTable({ base, search, rows }: { base: string; search: string; rows: RowView[] }) {
  const q = search ? `?${search}` : '';
  return (
    <TooltipProvider delayDuration={200}>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-[40%]">Query</TableHead>
            <TableHead className="text-right">Calls</TableHead>
            <TableHead>Time wasted</TableHead>
            <TableHead className="text-right">Avg</TableHead>
            <TableHead className="text-right">p95</TableHead>
            <TableHead className="text-right">Max</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r) => (
            <TableRow key={r.hash} className="group">
              <TableCell className="max-w-0">
                <Link href={`${base}/queries/${encodeURIComponent(r.hash)}${q}`} className="block font-medium group-hover:text-primary">
                  {r.title}
                </Link>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <code className="block truncate font-mono text-xs text-muted-foreground">{r.signature}</code>
                  </TooltipTrigger>
                  <TooltipContent className="max-w-md font-mono text-xs">{r.signature}</TooltipContent>
                </Tooltip>
              </TableCell>
              <TableCell className="text-right tabular-nums">{formatCount(r.count)}</TableCell>
              <TableCell>
                <div className="flex items-center gap-2">
                  <span className="w-14 tabular-nums">{r.wasted}</span>
                  <span className="h-1.5 w-24 overflow-hidden rounded-full bg-muted">
                    <span className="block h-full rounded-full bg-primary" style={{ width: `${Math.round(r.wastedShare * 100)}%` }} />
                  </span>
                </div>
              </TableCell>
              <TableCell className="text-right tabular-nums">{r.avg}</TableCell>
              <TableCell className="text-right"><Percentile label="p95" showLabel={false} value={r.p95} /></TableCell>
              <TableCell className="text-right tabular-nums">{r.max}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </TooltipProvider>
  );
}
