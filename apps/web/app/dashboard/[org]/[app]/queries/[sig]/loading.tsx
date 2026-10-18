import { PageHeader } from '@/components/dashboard/PageHeader';
import { Skeleton } from '@/components/ui/skeleton';

export default function Loading() {
  return (
    <>
      <PageHeader title={<Skeleton className="h-6 w-48" />} crumbs={[{ label: '…' }, { label: 'Queries' }]} />
      <div className="flex flex-col gap-6 p-6" aria-busy="true">
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          {Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-24 w-full" />)}
        </div>
        <div className="grid gap-4 lg:grid-cols-2">
          <Skeleton className="h-56 w-full" />
          <Skeleton className="h-56 w-full" />
        </div>
      </div>
    </>
  );
}
