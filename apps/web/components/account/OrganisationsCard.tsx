'use client';
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Loader2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { ROLE_LABEL, type Role } from '@/src/dashboard-types';
import { NEW_ORG_HREF, orgPath } from '@/src/landing';
import { BlockedAction } from '@/components/dashboard/BlockedAction';
import { PLAN_LIMIT_COPY } from '@/src/plan-limits';
import { GENERIC, HEADING_CLASS, JSON_HEADERS, errorOf, refreshSession } from './request';

type Org = { id: string; slug: string; name: string; role: Role };

/**
 * Account → Your organisations: open one, leave one (confirmed), or create
 * another. `canCreateOrg` false shows Create disabled with the plan's reason.
 */
export function OrganisationsCard({ orgs: initial, canCreateOrg }: { orgs: Org[]; canCreateOrg: boolean }) {
  const router = useRouter();
  const [orgs, setOrgs] = useState(initial);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<Org | null>(null);
  const [left, setLeft] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // After a row unmounts, focus goes to the heading rather than falling to <body>.
  const [focusHeading, setFocusHeading] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    if (!focusHeading) return;
    heading.current?.focus();
    setFocusHeading(false);
  }, [focusHeading]);

  const leave = async (org: Org) => {
    setError(null);
    setLeft(null);
    setBusy(org.id);
    try {
      const res = await fetch(`/api/orgs/${encodeURIComponent(org.id)}/membership`, {
        method: 'DELETE',
        // The CSRF guard refuses a mutation without a JSON content type.
        headers: JSON_HEADERS,
      });
      if (res.status === 401) return refreshSession();
      if (!res.ok) {
        setError(await errorOf(res));
        return;
      }
      setOrgs((prev) => prev.filter((o) => o.id !== org.id));
      setLeft(org.name);
      setFocusHeading(true);
      // Stay on Account; the switcher and landing read memberships from the server.
      router.refresh();
    } catch {
      setError(GENERIC);
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card>
      <CardHeader>
        <h2 ref={heading} tabIndex={-1} className={HEADING_CLASS}>Your organisations</h2>
      </CardHeader>
      <CardContent className="flex flex-col gap-4 text-sm">
        {orgs.length === 0 ? (
          <p className="text-muted-foreground">You&apos;re not in any organisation yet.</p>
        ) : (
          <ul className="flex flex-col divide-y divide-border/60">
            {orgs.map((o) => (
              <li key={o.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <div className="flex min-w-0 items-center gap-2">
                  <p className="truncate font-medium">{o.name}</p>
                  <Badge variant="secondary">{ROLE_LABEL[o.role]}</Badge>
                </div>
                <div className="flex items-center gap-2">
                  <Button asChild size="sm" variant="outline">
                    <Link href={orgPath(o.slug)} aria-label={`Open ${o.name}`}>Open</Link>
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={`Leave ${o.name}`}
                    disabled={busy === o.id}
                    onClick={() => setConfirm(o)}
                  >
                    {busy === o.id && <Loader2 className="size-4 animate-spin" aria-hidden />} Leave
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
        {left && <p role="status">You left {left}.</p>}
        {error && <p role="alert" className="text-destructive">{error}</p>}
        {canCreateOrg ? (
          <Button asChild size="sm" variant="outline" className="self-start">
            <Link href={NEW_ORG_HREF}>Create organisation</Link>
          </Button>
        ) : (
          <BlockedAction size="sm" label="Create organisation" reason={PLAN_LIMIT_COPY.orgs} />
        )}
      </CardContent>

      <AlertDialog open={confirm !== null} onOpenChange={(o) => { if (!o) setConfirm(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{`Leave ${confirm?.name ?? ''}?`}</AlertDialogTitle>
            <AlertDialogDescription>
              You lose access to its apps right away. Someone will need to invite you again.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => { if (confirm) void leave(confirm); }}>Leave organisation</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
