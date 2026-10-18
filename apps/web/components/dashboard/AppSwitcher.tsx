'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Check, ChevronsUpDown, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Command, CommandGroup, CommandItem, CommandList, CommandSeparator } from '@/components/ui/command';
import type { groupForSwitcher } from './switcher';

export function AppSwitcher({
  groups,
  currentLabel,
  newAppHref,
}: {
  groups: ReturnType<typeof groupForSwitcher>;
  currentLabel: { org: string; app: string };
  newAppHref: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  // Navigate once, from onSelect (cmdk fires it for both click and Enter), then close.
  const go = (href: string) => {
    setOpen(false);
    router.push(href);
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" className="h-auto w-full justify-between bg-background px-2 py-1.5">
          <span className="flex min-w-0 flex-col items-start text-left">
            <span className="truncate text-xs text-muted-foreground">{currentLabel.org}</span>
            <span className="truncate text-sm font-medium">{currentLabel.app}</span>
          </span>
          <ChevronsUpDown className="size-4 text-muted-foreground" aria-hidden />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-64 p-0" align="start">
        <Command>
          <CommandList>
            {groups.map((g) => (
              <CommandGroup key={g.org.slug} heading={g.org.name}>
                {g.apps.map((a) => (
                  <CommandItem key={a.id} value={`${g.org.slug}/${a.id}`} onSelect={() => go(a.href)}>
                    <span className="flex min-w-0 flex-1 items-center">
                      <span className="truncate">{a.name}</span>
                      <span className="ml-1 text-xs text-muted-foreground">{a.env}</span>
                      {a.current && <Check className="ml-auto size-4" aria-label="current" />}
                    </span>
                  </CommandItem>
                ))}
              </CommandGroup>
            ))}
            <CommandSeparator />
            <CommandGroup>
              <CommandItem value="new-app" onSelect={() => go(newAppHref)}>
                <span className="flex flex-1 items-center gap-2">
                  <Plus className="size-4" aria-hidden /> New app
                </span>
              </CommandItem>
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
