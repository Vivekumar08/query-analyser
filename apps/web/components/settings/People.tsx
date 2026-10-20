'use client';
import { useEffect, useRef, useState } from 'react';
import { Loader2, UserPlus, Users } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { CopyButton } from '@/components/dashboard/CopyButton';
import { ROLE_LABEL, type AppAccessList, type AppPerson, type Role } from '@/src/dashboard-types';
import { seatsLabel } from '@/src/plan-limits';

type Props = {
  /** The org's id (the API's `:org`), not its slug. */
  orgId: string;
  appId: string;
  /** The org plan's invitable roles; only MEMBER and VIEWER apply to an app. */
  invitableRoles: readonly Role[];
  /** null when the list failed to load. */
  initial: AppAccessList | null;
};
type Invite = AppAccessList['invites'][number];
type Notice = { email: string; link: string };

const GENERIC = 'Something went wrong. Please try again.';
const SELECT_CLASS = 'h-9 rounded-full border border-input bg-transparent px-3 text-sm outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-50';
const COPY_CLASS = 'rounded-full border px-3 py-1 text-xs text-muted-foreground hover:bg-muted';
const HEADING_CLASS = 'font-semibold outline-none';

function refreshSession(): void {
  window.location.assign(`/api/auth/refresh?next=${encodeURIComponent(window.location.pathname + window.location.search)}`);
}

async function errorOf(res: Response): Promise<string> {
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  return data.error ?? GENERIC;
}

/**
 * Settings → "People with access" (this app). Lists who can open the app —
 * owners and admins see every app; members and viewers were given this one —
 * with its pending invites and the org's seat usage. Inviting here invites to
 * this app, in the roles the plan allows.
 */
export function People({ orgId, appId, invitableRoles, initial }: Props) {
  const orgBase = `/api/orgs/${encodeURIComponent(orgId)}`;
  const accessUrl = `/api/apps/${encodeURIComponent(appId)}/access`;
  const roles = invitableRoles.filter((r) => r === 'MEMBER' || r === 'VIEWER');

  const [people, setPeople] = useState<AppPerson[]>(initial?.people ?? []);
  const [invites, setInvites] = useState<Invite[]>(initial?.invites ?? []);
  const [seats, setSeats] = useState(initial?.seats ?? null);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Role>(roles.includes('MEMBER') ? 'MEMBER' : (roles[0] ?? 'MEMBER'));
  const [inviting, setInviting] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [confirm, setConfirm] = useState<AppPerson | null>(null);
  // After a row unmounts, focus goes to its list's heading rather than falling to <body>.
  const [focusTo, setFocusTo] = useState<'people' | 'invites' | null>(null);
  const peopleHeading = useRef<HTMLHeadingElement>(null);
  const invitesHeading = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    if (!focusTo) return;
    (focusTo === 'people' ? peopleHeading : invitesHeading).current?.focus();
    setFocusTo(null);
  }, [focusTo]);

  /** Re-reads the list; on failure the current state stays as it is. */
  const reload = async () => {
    const res = await fetch(accessUrl).catch(() => null);
    if (!res?.ok) return;
    const data = (await res.json().catch(() => null)) as AppAccessList | null;
    if (!data) return;
    setPeople(data.people);
    setInvites(data.invites);
    setSeats(data.seats);
  };

  const sendInvite = async () => {
    const address = email.trim();
    if (!/^[^\s@]+@[^\s@]+$/.test(address)) {
      setError('Enter a valid email address.');
      return;
    }
    setError(null);
    setNotice(null);
    setInviting(true);
    try {
      const res = await fetch(`${orgBase}/invites`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: address, role, appId }),
      });
      if (res.status === 401) return refreshSession();
      if (!res.ok) {
        setError(await errorOf(res));
        return;
      }
      const created = (await res.json()) as { email: string; inviteLink: string };
      setNotice({ email: created.email, link: created.inviteLink });
      setEmail('');
      await reload();
    } catch {
      setError(GENERIC);
    } finally {
      setInviting(false);
    }
  };

  const revoke = async (invite: Invite) => {
    setError(null);
    setNotice(null);
    setBusy(invite.id);
    try {
      const res = await fetch(`${orgBase}/invites/${encodeURIComponent(invite.id)}`, {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
      });
      if (res.status === 401) return refreshSession();
      // 404: already gone (accepted, expired or revoked elsewhere) — drop it either way, but say why.
      if (!res.ok && res.status !== 404) {
        setError(await errorOf(res));
        return;
      }
      if (res.status === 404) setError(await errorOf(res));
      setInvites((prev) => prev.filter((i) => i.id !== invite.id));
      setFocusTo('invites');
      await reload();
    } catch {
      setError(GENERIC);
    } finally {
      setBusy(null);
    }
  };

  const removeAccess = async (person: AppPerson) => {
    setError(null);
    setNotice(null);
    setBusy(person.userId);
    try {
      const res = await fetch(`${accessUrl}/${encodeURIComponent(person.userId)}`, {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
      });
      if (res.status === 401) return refreshSession();
      if (!res.ok) {
        setError(await errorOf(res));
        return;
      }
      setPeople((prev) => prev.filter((p) => p.userId !== person.userId));
      setFocusTo('people');
    } catch {
      setError(GENERIC);
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card>
      <CardHeader className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 ref={peopleHeading} tabIndex={-1} className={`flex items-center gap-2 text-base ${HEADING_CLASS}`}>
          <Users className="size-4" aria-hidden /> People with access
        </h2>
        {seats && <p className="text-xs text-muted-foreground">{seatsLabel(seats)}</p>}
      </CardHeader>
      <CardContent className="flex flex-col gap-6 text-sm">
        {initial === null ? (
          <p className="text-muted-foreground">Couldn&apos;t load who has access. Refresh the page to try again.</p>
        ) : (
          <ul className="flex flex-col divide-y divide-border/60">
            {people.map((p) => (
              <li key={p.userId} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <div className="min-w-0">
                  <p className="truncate font-medium">{p.name || p.email}</p>
                  <p className="truncate text-xs text-muted-foreground">{p.email}</p>
                </div>
                <div className="flex items-center gap-2">
                  <Badge variant="secondary">{ROLE_LABEL[p.role]}</Badge>
                  {p.allApps ? (
                    <Badge variant="outline">All apps</Badge>
                  ) : (
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-label={`Remove ${p.email}’s access`}
                      disabled={busy === p.userId}
                      onClick={() => setConfirm(p)}
                    >
                      {busy === p.userId && <Loader2 className="size-4 animate-spin" aria-hidden />} Remove access
                    </Button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}

        {roles.length > 0 && (
          <form
            noValidate
            className="flex flex-col gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              void sendInvite();
            }}
          >
            <p className="flex items-center gap-2 font-medium"><UserPlus className="size-4" aria-hidden /> Invite to this app</p>
            <div className="flex flex-wrap items-end gap-2">
              <div className="flex min-w-56 flex-1 flex-col gap-1">
                <label htmlFor="people-invite-email" className="text-xs font-medium">Email</label>
                <Input id="people-invite-email" type="email" autoComplete="off" value={email} onChange={(e) => setEmail(e.target.value)} />
              </div>
              <div className="flex flex-col gap-1">
                <label htmlFor="people-invite-role" className="text-xs font-medium">Role</label>
                <select id="people-invite-role" className={SELECT_CLASS} value={role} onChange={(e) => setRole(e.target.value as Role)}>
                  {roles.map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
                </select>
              </div>
              <Button type="submit" size="sm" className="h-9" disabled={inviting}>
                {inviting && <Loader2 className="size-4 animate-spin" aria-hidden />} Send invite
              </Button>
            </div>
          </form>
        )}

        {notice && (
          <div className="flex flex-col gap-2">
            <p role="status">
              Invite sent to <span className="font-medium text-accent-text">{notice.email}</span>. If the email doesn&apos;t
              arrive, share this link — it works once and expires in 7 days:
            </p>
            <div className="flex items-start gap-2">
              <pre className="flex-1 overflow-x-auto rounded-xl border bg-muted p-3 font-mono text-xs"><code>{notice.link}</code></pre>
              <CopyButton text={notice.link} label="Copy the invite link" className={COPY_CLASS} />
            </div>
          </div>
        )}
        {error && <p role="alert" className="text-destructive">{error}</p>}

        <div className="flex flex-col gap-2">
          <h3 ref={invitesHeading} tabIndex={-1} className={HEADING_CLASS}>Pending invites</h3>
          {invites.length === 0 ? (
            <p className="text-muted-foreground">
              {initial === null ? "Couldn't load pending invites. Refresh the page to try again." : 'No pending invites.'}
            </p>
          ) : (
            <ul className="flex flex-col divide-y divide-border/60">
              {invites.map((i) => (
                <li key={i.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                  <div className="min-w-0">
                    <p className="truncate font-medium">{i.email}</p>
                    <p className="text-xs text-muted-foreground">{ROLE_LABEL[i.role]} · expires {i.expiresAt.slice(0, 10)}</p>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    aria-label={`Revoke the invite for ${i.email}`}
                    disabled={busy === i.id}
                    onClick={() => void revoke(i)}
                  >
                    {busy === i.id && <Loader2 className="size-4 animate-spin" aria-hidden />} Revoke
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </CardContent>

      <AlertDialog open={confirm !== null} onOpenChange={(o) => { if (!o) setConfirm(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{`Remove ${confirm?.email ?? ''}’s access to this app?`}</AlertDialogTitle>
            <AlertDialogDescription>
              They can no longer open this app. They stay in the workspace, with any other apps they were given.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => { if (confirm) void removeAccess(confirm); }}>Remove access</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
