import { cn } from '@/lib/utils';

export function ExternalLink({
  href,
  className,
  children,
}: {
  href: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className={cn('hover:text-foreground', className)}>
      {children}
    </a>
  );
}
