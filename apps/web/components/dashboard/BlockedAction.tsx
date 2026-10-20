import { useId } from 'react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/**
 * A create action the plan doesn't allow right now: still visible and still
 * focusable (aria-disabled, not disabled), never a link, with the reason as
 * its description. A hint only; the API is the real gate.
 */
export function BlockedAction({
  label,
  reason,
  size,
  className,
}: {
  label: string;
  reason: string;
  size?: 'sm';
  className?: string;
}) {
  const id = useId();
  return (
    <div className={cn('flex flex-col gap-1', className)}>
      <Button
        type="button"
        size={size}
        variant="outline"
        aria-disabled="true"
        aria-describedby={id}
        // No hover change: nothing happens on click.
        className="self-start cursor-not-allowed opacity-50 hover:bg-background hover:text-foreground dark:hover:bg-input/30"
      >
        {label}
      </Button>
      <p id={id} className="text-xs text-muted-foreground">{reason}</p>
    </div>
  );
}
