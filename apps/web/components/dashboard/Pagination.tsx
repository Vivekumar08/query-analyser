import Link from 'next/link';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';

function Step({ href, disabled, label, children }: {
  href: string; disabled: boolean; label: string; children: React.ReactNode;
}) {
  if (disabled) {
    return (
      <Button variant="ghost" size="sm" aria-disabled="true" tabIndex={-1} className="pointer-events-none opacity-50">
        {children}
      </Button>
    );
  }
  return (
    <Button asChild variant="outline" size="sm">
      <Link href={href} scroll={false} aria-label={label}>{children}</Link>
    </Button>
  );
}

export function Pagination({ page, hasMore, hrefFor }: {
  page: number; hasMore: boolean; hrefFor: (page: number) => string;
}) {
  return (
    <nav aria-label="Pagination" className="flex items-center justify-center gap-3">
      <Step href={hrefFor(page - 1)} disabled={page <= 1} label="Previous page">
        <ChevronLeft aria-hidden /><span>Previous</span>
      </Step>
      <span className="text-sm text-muted-foreground">Page {page}</span>
      <Step href={hrefFor(page + 1)} disabled={!hasMore} label="Next page">
        <span>Next</span><ChevronRight aria-hidden />
      </Step>
    </nav>
  );
}
