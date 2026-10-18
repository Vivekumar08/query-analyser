import { cn } from '@/lib/utils';

/** Frosted surface over the haze. `strong` (~90% white) for dense content. */
export function GlassCard({
  strong = false,
  className,
  children,
}: {
  strong?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  return <div className={cn(strong ? 'glass-strong' : 'glass', 'rounded-2xl', className)}>{children}</div>;
}
