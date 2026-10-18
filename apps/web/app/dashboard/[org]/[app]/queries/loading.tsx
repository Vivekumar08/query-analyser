import { PageHeader } from '@/components/dashboard/PageHeader';
import { Skeleton } from '@/components/ui/skeleton';

export default function Loading() {
  return (
    <>
      <PageHeader title="Queries" crumbs={[{ label: '…' }, { label: 'Queries' }]} />
      <div className="flex flex-col gap-2 p-6" aria-busy="true">
        {Array.from({ length: 8 }, (_, i) => <Skeleton key={i} className="h-10 w-full" />)}
      </div>
    </>
  );
}
