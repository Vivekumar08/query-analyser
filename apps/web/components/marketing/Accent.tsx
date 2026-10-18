import { cn } from '@/lib/utils';

/** One italic serif accent word inside a sans heading ("quietly", "never values"). */
export function Accent({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <em className={cn('font-serif font-normal italic tracking-normal text-accent-text', className)}>
      {children}
    </em>
  );
}
