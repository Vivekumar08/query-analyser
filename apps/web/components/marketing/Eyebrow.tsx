import { cn } from '@/lib/utils';

export function Eyebrow({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <p className={cn('text-xs font-medium uppercase tracking-[0.14em] text-accent-text', className)}>
      {children}
    </p>
  );
}
