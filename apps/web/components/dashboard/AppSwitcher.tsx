'use client';
import { useId, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Building2, Check, ChevronsUpDown, Plus, UserRound } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Command, CommandGroup, CommandItem, CommandList, CommandSeparator } from '@/components/ui/command';
import { ROLE_LABEL } from '@/src/dashboard-types';
import { ACCOUNT_HREF, NEW_ORG_HREF } from '@/src/landing';
import type { groupForSwitcher, orgsForSwitcher } from './switcher';

/**
 * A create item the plan doesn't allow: visible, disabled, never a link, with
 * the plan's reason as its description. The API is the real gate.
 */
function BlockedItem({ value, icon, label, reason }: { value: string; icon: React.ReactNode; label: string; reason: string }) {
  const id = useId();
  return (
    <CommandItem disabled value={value} aria-describedby={id} className="flex-col items-start gap-0.5">
      <span className="flex items-center gap-2">{icon} {label}</span>
      <span id={id} className="text-xs text-muted-foreground">{reason}</span>
    </CommandItem>
  );
}

export function AppSwitcher({
  groups,
  orgs,
  currentLabel,
  newApp,
  newOrgBlocked,
}: {
  groups: ReturnType<typeof groupForSwitcher>;
  orgs: ReturnType<typeof orgsForSwitcher>;
  currentLabel: { org: string; app: string };
  /**
   * null hides New app (the caller's role in this org cannot create apps);
   * `blocked` is the plan-limit copy when the org has no room for another app.
   */
  newApp: { href: string; blocked: string | null } | null;
  /** The plan-limit copy when the user can't create another organisation, else null. */
  newOrgBlocked: string | null;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  // Items are real anchors (middle/cmd-click open a new tab). A plain click follows
  // the Link, and stopPropagation keeps cmdk's click-driven onSelect from navigating
  // a second time; onSelect still handles keyboard Enter.
  const go = (href: string) => {
    setOpen(false);
    router.push(href);
  };
  const close = (e: React.MouseEvent) => {
    e.stopPropagation();
    // Leave the popover (and the anchor) mounted for modifier-clicks so the browser opens the tab.
    if (!(e.metaKey || e.ctrlKey || e.shiftKey || e.altKey)) setOpen(false);
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
            <CommandGroup heading="Organisations">
              {orgs.map((o) => (
                <CommandItem key={o.slug} value={`org:${o.slug}`} onSelect={() => go(o.href)}>
                  <Link href={o.href} onClick={close} className="flex min-w-0 flex-1 items-center gap-1">
                    <span className="truncate">{o.name}</span>
                    <span className="text-xs text-muted-foreground">{ROLE_LABEL[o.role]}</span>
                    {o.current && <Check className="ml-auto size-4" aria-label="current organisation" />}
                  </Link>
                </CommandItem>
              ))}
            </CommandGroup>
            {groups.map((g) => (
              <CommandGroup key={g.org.slug} heading={g.org.name}>
                {g.apps.map((a) => (
                  <CommandItem key={a.id} value={`${g.org.slug}/${a.id}`} onSelect={() => go(a.href)}>
                    <Link href={a.href} onClick={close} className="flex min-w-0 flex-1 items-center">
                      <span className="truncate">{a.name}</span>
                      <span className="ml-1 text-xs text-muted-foreground">{a.env}</span>
                      {a.current && <Check className="ml-auto size-4" aria-label="current" />}
                    </Link>
                  </CommandItem>
                ))}
              </CommandGroup>
            ))}
            <CommandSeparator />
            <CommandGroup>
              {newApp && (newApp.blocked ? (
                <BlockedItem value="new-app" icon={<Plus className="size-4" aria-hidden />} label="New app" reason={newApp.blocked} />
              ) : (
                <CommandItem value="new-app" onSelect={() => go(newApp.href)}>
                  <Link href={newApp.href} onClick={close} className="flex flex-1 items-center gap-2">
                    <Plus className="size-4" aria-hidden /> New app
                  </Link>
                </CommandItem>
              ))}
              {newOrgBlocked ? (
                <BlockedItem value="new-org" icon={<Building2 className="size-4" aria-hidden />} label="New organisation" reason={newOrgBlocked} />
              ) : (
                <CommandItem value="new-org" onSelect={() => go(NEW_ORG_HREF)}>
                  <Link href={NEW_ORG_HREF} onClick={close} className="flex flex-1 items-center gap-2">
                    <Building2 className="size-4" aria-hidden /> New organisation
                  </Link>
                </CommandItem>
              )}
              <CommandItem value="account" onSelect={() => go(ACCOUNT_HREF)}>
                <Link href={ACCOUNT_HREF} onClick={close} className="flex flex-1 items-center gap-2">
                  <UserRound className="size-4" aria-hidden /> Account
                </Link>
              </CommandItem>
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
