'use client';
import { useEffect, useId, useRef, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { format } from 'date-fns';
import type { DateRange } from 'react-day-picker';
import { CalendarDays } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Calendar } from '@/components/ui/calendar';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { earliestKeptDay, presetAllowed, rangeToParams, type RangePreset, type RangeState } from '@/src/range';
import { retentionNote } from '@/src/plan-limits';

const PRESETS: RangePreset[] = ['1h', '24h', '7d', '30d'];
const RANGE_KEYS = ['range', 'from', 'to'] as const;
const day = (d: Date) => format(d, 'yyyy-MM-dd');
// Stored custom bounds are UTC ISO strings; the calendar works in local dates.
const asLocalDay = (iso: string) => {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  return new Date(y!, m! - 1, d!);
};

/**
 * Presets and a custom range, limited to what the plan keeps: longer presets
 * and older days are disabled, with "Kept for N days on your plan" saying why.
 * The server applies the same limit when it reads the URL (parseRange).
 */
export function RangeControl({ value, retentionDays }: { value: RangeState; retentionDays: number }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<DateRange | undefined>(
    value.kind === 'custom' ? { from: asLocalDay(value.from), to: asLocalDay(value.to) } : undefined,
  );

  const noteId = useId();
  const anyBlocked = PRESETS.some((p) => !presetAllowed(p, retentionDays));

  // The server limits the URL's range to what the plan keeps (parseRange), so
  // a bookmarked ?range=30d on a 7-day plan renders 24h. Put the range that was
  // drawn back in the URL, once per value, so the URL never claims otherwise.
  const canonicalKey = JSON.stringify(rangeToParams(value));
  const synced = useRef<string | null>(null);
  useEffect(() => {
    if (synced.current === canonicalKey) return;
    synced.current = canonicalKey;
    const want: Record<string, string | undefined> = JSON.parse(canonicalKey);
    if (RANGE_KEYS.every((k) => (params.get(k) ?? undefined) === want[k])) return;
    const s = new URLSearchParams(params.toString());
    for (const k of RANGE_KEYS) {
      const v = want[k];
      if (v === undefined) s.delete(k);
      else s.set(k, v);
    }
    const qs = s.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  }, [canonicalKey, params, pathname, router]);
  const earliest = earliestKeptDay(retentionDays);
  const today = new Date();
  const disabledDays = earliest
    ? [{ after: today }, { before: asLocalDay(earliest.toISOString()) }]
    : { after: today };

  const apply = (next: Record<string, string | null>) => {
    const s = new URLSearchParams(params.toString());
    for (const [k, v] of Object.entries(next)) {
      if (v === null) s.delete(k);
      else s.set(k, v);
    }
    s.delete('page');
    const qs = s.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  };

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex items-center gap-2">
        <ToggleGroup
          type="single"
          variant="outline"
          size="sm"
          value={value.kind === 'preset' ? value.preset : ''}
          onValueChange={(v) => v && apply({ range: v === '24h' ? null : v, from: null, to: null })}
          aria-label="Time range"
        >
          {PRESETS.map((p) => {
            const allowed = presetAllowed(p, retentionDays);
            return (
              <ToggleGroupItem
              key={p}
              value={p}
              disabled={!allowed}
              title={allowed ? undefined : retentionNote(retentionDays)}
              aria-describedby={allowed ? undefined : noteId}
            >
                {p}
              </ToggleGroupItem>
            );
          })}
        </ToggleGroup>
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <Button variant={value.kind === 'custom' ? 'secondary' : 'outline'} size="sm">
              <CalendarDays className="size-4" aria-hidden />
              {value.kind === 'custom' ? `${value.from.slice(0, 10)} → ${value.to.slice(0, 10)}` : 'Custom'}
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-auto p-0" align="end">
            <Calendar mode="range" numberOfMonths={2} selected={draft} onSelect={setDraft} disabled={disabledDays} />
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
      {anyBlocked && <p id={noteId} className="text-xs text-muted-foreground">{retentionNote(retentionDays)}</p>}
    </div>
  );
}
