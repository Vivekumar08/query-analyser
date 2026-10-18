import Link from 'next/link';
import { Button } from '@/components/ui/button';

export default function NotFound() {
  return (
    <div className="mx-auto flex max-w-md flex-col items-center gap-3 px-6 py-24 text-center">
      <h2 className="text-lg font-semibold">Not found, or you don&apos;t have access</h2>
      <p className="text-sm text-muted-foreground">Check the link, or go back to your dashboard.</p>
      <Button asChild><Link href="/dashboard">Go to dashboard</Link></Button>
    </div>
  );
}
