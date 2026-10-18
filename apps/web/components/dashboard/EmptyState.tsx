import Link from 'next/link';
import { SearchX, Inbox } from 'lucide-react';
import { Button } from '@/components/ui/button';

export function QueriesEmpty({ kind, clearHref, installHref }: { kind: 'no-data' | 'no-match'; clearHref: string; installHref: string }) {
  const Icon = kind === 'no-data' ? Inbox : SearchX;
  return (
    <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed px-6 py-16 text-center">
      <Icon className="size-8 text-muted-foreground" aria-hidden />
      {kind === 'no-data' ? (
        <>
          <p className="font-medium">No queries ≥ 100ms in this window.</p>
          <p className="max-w-sm text-sm text-muted-foreground">Try a longer range like 7 days, or check that your app is sending data.</p>
          <Button asChild variant="outline">
            <a href={installHref} target="_blank" rel="noreferrer noopener">View install instructions</a>
          </Button>
        </>
      ) : (
        <>
          <p className="font-medium">No queries match these filters.</p>
          <Button asChild variant="outline"><Link href={clearHref}>Clear filters</Link></Button>
        </>
      )}
    </div>
  );
}
