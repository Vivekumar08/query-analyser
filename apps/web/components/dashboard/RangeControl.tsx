'use client';
import { useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { format } from 'date-fns';
import type { DateRange } from 'react-day-picker';
import { CalendarDays } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Calendar } from '@/components/ui/calendar';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import type { RangePreset, RangeState } from '@/src/range';

const PRESETS: RangePreset[] = ['1h', '24h', '7d', '30d'];
const day = (d: Date) => format(d, 'yyyy-MM-dd');
// Stored custom bounds are UTC ISO strings; the calendar works in local dates.
const asLocalDay = (iso: string) => {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  return new Date(y!, m! - 1, d!);
};

export function RangeControl({ value }: { value: RangeState }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<DateRange | undefined>(
    value.kind === 'custom' ? { from: asLocalDay(value.from), to: asLocalDay(value.to) } : undefined,
  );

  const apply = (next: Record<string, string | null>) => {
    const s = new URLSearchParams(params.toString());
    for (const [k, v] of Object.entries(next)) {
      if (v === null) s.delete(k);
      else s.set(k, v);
    }
    s.delete('limit');
    const qs = s.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  };

  return (
    <div className="flex items-center gap-2">
      <ToggleGroup
        type="single"
        variant="outline"
        size="sm"
        value={value.kind === 'preset' ? value.preset : ''}
        onValueChange={(v) => v && apply({ range: v === '24h' ? null : v, from: null, to: null })}
        aria-label="Time range"
      >
        {PRESETS.map((p) => <ToggleGroupItem key={p} value={p}>{p}</ToggleGroupItem>)}
      </ToggleGroup>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button variant={value.kind === 'custom' ? 'secondary' : 'outline'} size="sm">
            <CalendarDays className="size-4" aria-hidden />
            {value.kind === 'custom' ? `${value.from.slice(0, 10)} → ${value.to.slice(0, 10)}` : 'Custom'}
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-auto p-0" align="end">
          <Calendar mode="range" numberOfMonths={2} selected={draft} onSelect={setDraft} disabled={{ after: new Date() }} />
          <div className="flex items-center justify-between gap-2 border-t p-2">
            <span className="text-xs text-muted-foreground">Dates are UTC days.</span>
            <div className="flex gap-2">
              <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
              <Button
                size="sm"
                disabled={!draft?.from || !draft?.to}
                onClick={() => {
                  apply({ range: 'custom', from: day(draft!.from!), to: day(draft!.to!) });
                  setOpen(false);
                }}
              >
                Apply
              </Button>
            </div>
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}
