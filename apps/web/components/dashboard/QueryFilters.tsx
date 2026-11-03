'use client';
import { useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Check, ChevronDown, ListFilter } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command';
import { DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { sourceLabel } from '@/src/sources';
import type { QueryFilters, SortKey } from '@/src/filters';

const SORTS: { key: SortKey; label: string }[] = [
  { key: 'wasted', label: 'Time wasted' },
  { key: 'count', label: 'Calls' },
  { key: 'p95', label: 'p95' },
  { key: 'maxMs', label: 'Max' },
  { key: 'errors', label: 'Errors' },
];

/** Single select with an "All" option; the API accepts one value per filter. */
function SingleSelect({ label, options, selected, onChange, display = (v) => v }: {
  label: string; options: string[]; selected: string | undefined; onChange: (next: string | null) => void;
  /** Text shown for a value (the value itself is what goes in the URL). */
  display?: (value: string) => string;
}) {
  const [open, setOpen] = useState(false);
  const pick = (v: string | null) => {
    setOpen(false);
    onChange(v);
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm">
          <ListFilter className="size-4" aria-hidden />
          <span className="max-w-40 truncate">{label}: {selected !== undefined ? display(selected) : 'All'}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-56 p-0" align="start">
        <Command>
          <CommandInput placeholder={`Search ${label.toLowerCase()}…`} />
          <CommandList>
            <CommandEmpty>None found.</CommandEmpty>
            <CommandGroup>
              <CommandItem value="__all__" keywords={['all']} onSelect={() => pick(null)}>
                <Check className={`size-4 ${selected === undefined ? 'opacity-100' : 'opacity-0'}`} aria-hidden />
                All
              </CommandItem>
              {options.map((o) => (
                <CommandItem key={o} value={o} keywords={[display(o)]} onSelect={() => pick(o)}>
                  <Check className={`size-4 ${selected === o ? 'opacity-100' : 'opacity-0'}`} aria-hidden />
                  <span className="truncate">{display(o)}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

export function QueryFiltersBar({ models, ops, sources, orms, value }: { models: string[]; ops: string[]; sources: string[]; orms: string[]; value: QueryFilters }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();

  // Replaces model/op/sort (null clears), keeps range/from/to, resets paging.
  const apply = (next: { model?: string | null; op?: string | null; source?: string | null; orm?: string | null; sort?: SortKey | null }) => {
    const s = new URLSearchParams(params.toString());
    s.delete('page');
    if (next.model !== undefined) { s.delete('model'); if (next.model) s.set('model', next.model); }
    if (next.op !== undefined) { s.delete('op'); if (next.op) s.set('op', next.op); }
    if (next.source !== undefined) { s.delete('source'); if (next.source) s.set('source', next.source); }
    if (next.orm !== undefined) { s.delete('orm'); if (next.orm) s.set('orm', next.orm); }
    if (next.sort !== undefined) {
      if (next.sort === null || next.sort === 'wasted') s.delete('sort');
      else s.set('sort', next.sort);
    }
    const qs = s.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  };

  const dirty = value.model !== undefined || value.op !== undefined || value.source !== undefined || value.orm !== undefined || value.sort !== 'wasted';
  const sortLabel = SORTS.find((s) => s.key === value.sort)!.label;

  return (
    <div className="flex flex-wrap items-center gap-2">
      <SingleSelect label="Database" options={sources} selected={value.source} display={sourceLabel} onChange={(s) => apply({ source: s })} />
      <SingleSelect label="ORM" options={orms} selected={value.orm} onChange={(o) => apply({ orm: o })} />
      <SingleSelect label="Model" options={models} selected={value.model} onChange={(m) => apply({ model: m })} />
      <SingleSelect label="Operation" options={ops} selected={value.op} onChange={(o) => apply({ op: o })} />
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm">
            Sort: {sortLabel}
            <ChevronDown className="size-4" aria-hidden />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          <DropdownMenuRadioGroup value={value.sort} onValueChange={(v) => apply({ sort: v as SortKey })}>
            {SORTS.map((s) => <DropdownMenuRadioItem key={s.key} value={s.key}>{s.label}</DropdownMenuRadioItem>)}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
      {dirty && (
        <Button variant="ghost" size="sm" onClick={() => apply({ model: null, op: null, source: null, orm: null, sort: null })}>Clear</Button>
      )}
    </div>
  );
}
