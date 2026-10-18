'use client';
import { useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Check, ChevronDown, ListFilter } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command';
import { DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import type { QueryFilters, SortKey } from '@/src/filters';

const SORTS: { key: SortKey; label: string }[] = [
  { key: 'wasted', label: 'Time wasted' },
  { key: 'count', label: 'Calls' },
  { key: 'p95', label: 'p95' },
  { key: 'maxMs', label: 'Max' },
];

function MultiSelect({ label, options, selected, onChange }: {
  label: string; options: string[]; selected: string[]; onChange: (next: string[]) => void;
}) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm">
          <ListFilter className="size-4" aria-hidden />
          {label}
          {selected.length > 0 && <span className="rounded bg-muted px-1.5 text-xs">{selected.length}</span>}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-56 p-0" align="start">
        <Command>
          <CommandInput placeholder={`Search ${label.toLowerCase()}…`} />
          <CommandList>
            <CommandEmpty>None found.</CommandEmpty>
            <CommandGroup>
              {options.map((o) => {
                const on = selected.includes(o);
                return (
                  <CommandItem key={o} value={o} onSelect={() => onChange(on ? selected.filter((s) => s !== o) : [...selected, o])}>
                    <Check className={`size-4 ${on ? 'opacity-100' : 'opacity-0'}`} aria-hidden />
                    <span className="truncate">{o}</span>
                  </CommandItem>
                );
              })}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

export function QueryFiltersBar({ models, ops, value }: { models: string[]; ops: string[]; value: QueryFilters }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [sortOpen, setSortOpen] = useState(false);

  // Rewrites model/op/sort, keeps range/from/to, resets paging.
  const apply = (next: { models?: string[]; ops?: string[]; sort?: SortKey | null }) => {
    const s = new URLSearchParams(params.toString());
    s.delete('limit');
    if (next.models) { s.delete('model'); next.models.forEach((m) => s.append('model', m)); }
    if (next.ops) { s.delete('op'); next.ops.forEach((o) => s.append('op', o)); }
    if (next.sort !== undefined) {
      if (next.sort === null || next.sort === 'wasted') s.delete('sort');
      else s.set('sort', next.sort);
    }
    const qs = s.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  };

  const dirty = value.models.length > 0 || value.ops.length > 0 || value.sort !== 'wasted';
  const sortLabel = SORTS.find((s) => s.key === value.sort)!.label;

  return (
    <div className="flex flex-wrap items-center gap-2">
      <MultiSelect label="Model" options={models} selected={value.models} onChange={(m) => apply({ models: m })} />
      <MultiSelect label="Operation" options={ops} selected={value.ops} onChange={(o) => apply({ ops: o })} />
      <DropdownMenu open={sortOpen} onOpenChange={setSortOpen}>
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
        <Button variant="ghost" size="sm" onClick={() => apply({ models: [], ops: [], sort: null })}>Clear</Button>
      )}
    </div>
  );
}
