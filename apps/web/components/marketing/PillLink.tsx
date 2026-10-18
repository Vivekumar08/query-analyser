import Link from 'next/link';
import { cn } from '@/lib/utils';

const VARIANTS = {
  ink: 'bg-primary text-primary-foreground hover:bg-primary/90',
  ghost: 'glass text-foreground hover:bg-white/90',
} as const;

export function PillLink({
  href,
  variant = 'ink',
  className,
  children,
}: {
  href: string;
  variant?: keyof typeof VARIANTS;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full px-5 py-2.5 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50',
        VARIANTS[variant],
        className,
      )}
    >
      {children}
    </Link>
  );
}
