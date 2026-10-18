'use client';
import { Button } from '@/components/ui/button';

export default function DashboardError({ reset }: { error: Error; reset: () => void }) {
  return (
    <div className="mx-auto flex max-w-md flex-col items-center gap-3 px-6 py-24 text-center">
      <h2 className="text-lg font-semibold">Couldn&apos;t load this page</h2>
      <p className="text-sm text-muted-foreground">The service may be briefly unavailable. Your data is safe.</p>
      <Button onClick={reset}>Retry</Button>
    </div>
  );
}
