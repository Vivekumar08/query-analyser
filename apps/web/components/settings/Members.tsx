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
import { ROLES, ROLE_LABEL, isAdminRole, type Member, type PendingInvite, type Role } from '@/src/dashboard-types';
import { appAccessSummary } from '@/src/plan-limits';

type Props = {
  /** The org's id (the API's `:org`), not its slug. */
  orgId: string;
  viewerRole: Role;
  viewerUserId: string;
  /** The org plan's invitable roles: ADMIN here means admins can be invited, and limits the role select. */
  invitableRoles: readonly Role[];
  /** null when the list failed to load. */
  initialMembers: Member[] | null;
  /** Org-wide invites only (`appId` null); app invites belong to People with access. null when the list failed to load. */
  initialInvites: PendingInvite[] | null;
};
type Confirm = { kind: 'role'; member: Member; role: Role } | { kind: 'remove'; member: Member };
type Notice = { email: string; link: string };

const GENERIC = 'Something went wrong. Please try again.';
const SELECT_CLASS = 'h-8 rounded-full border border-input bg-transparent px-3 text-sm outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-50';
const COPY_CLASS = 'rounded-full border px-3 py-1 text-xs text-muted-foreground hover:bg-muted';
const HEADING_CLASS = 'font-semibold outline-none';

function refreshSession(): void {
  window.location.assign(`/api/auth/refresh?next=${encodeURIComponent(window.location.pathname + window.location.search)}`);
}

/**
 * The row after a role change, mirroring what the API does to app access:
 * promoted to OWNER/ADMIN sees every app; demoted from there keeps every app
 * that exists (still "All apps"); MEMBER↔VIEWER changes the role on each app.
 */
function withRole(m: Member, role: Role): Member {
  if (isAdminRole(role)) return { ...m, role, allApps: true, apps: [] };
  if (m.allApps) return { ...m, role };
  return { ...m, role, apps: m.apps.map((a) => ({ ...a, role })) };
}

async function errorOf(res: Response): Promise<string> {
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  return data.error ?? GENERIC;
}

/**
 * Settings → Members (org-wide, ADMIN+): everyone in the org with the apps
 * they can open. ADMINs revoke org-wide invites and, on plans that allow it,
 * invite admins; OWNERs also change roles and remove members, each behind a
 * confirmation. Teammates are invited to an app from People with access.
 */
export function Members({ orgId, viewerRole, viewerUserId, invitableRoles, initialMembers, initialInvites }: Props) {
  const isOwner = viewerRole === 'OWNER';
  const canInviteAdmin = invitableRoles.includes('ADMIN');
  const base = `/api/orgs/${encodeURIComponent(orgId)}`;

  const [members, setMembers] = useState<Member[]>(initialMembers ?? []);
  const [invites, setInvites] = useState<PendingInvite[]>(initialInvites ?? []);
  const [email, setEmail] = useState('');
  const [inviting, setInviting] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  // After a row unmounts, focus goes to its list's heading rather than falling to <body>.
  const [focusTo, setFocusTo] = useState<'members' | 'invites' | null>(null);
  const membersHeading = useRef<HTMLHeadingElement>(null);
  const invitesHeading = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    if (!focusTo) return;
    (focusTo === 'members' ? membersHeading : invitesHeading).current?.focus();
    setFocusTo(null);
  }, [focusTo]);

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
      const res = await fetch(`${base}/invites`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: address, role: 'ADMIN' }),
      });
      if (res.status === 401) return refreshSession();
      if (!res.ok) {
        setError(await errorOf(res));
        return;
      }
      const created = (await res.json()) as PendingInvite & { inviteLink: string };
      setNotice({ email: created.email, link: created.inviteLink });
      setEmail('');
      // Re-read the list (a re-invite adds a row the API dedupes nowhere); fall back to prepending.
      // App invites are listed under People with access, so only org-wide ones stay here.
      const list = await fetch(`${base}/invites`).catch(() => null);
      if (list?.ok) setInvites(((await list.json()) as PendingInvite[]).filter((i) => i.appId === null));
      else {
        const { inviteLink: _link, ...invite } = created;
        setInvites((prev) => [{ ...invite, appId: null, createdAt: new Date().toISOString() }, ...prev]);
      }
    } catch {
      setError(GENERIC);
    } finally {
      setInviting(false);
    }
  };

  const revoke = async (invite: PendingInvite) => {
    setError(null);
    setNotice(null);
    setBusy(invite.id);
    try {
      const res = await fetch(`${base}/invites/${encodeURIComponent(invite.id)}`, {
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
    } catch {
      setError(GENERIC);
    } finally {
      setBusy(null);
    }
  };

  const runConfirmed = async (c: Confirm) => {
    setError(null);
    setNotice(null);
    setBusy(c.member.id);
    const url = `${base}/members/${encodeURIComponent(c.member.id)}`;
    try {
      const res = c.kind === 'role'
        ? await fetch(url, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ role: c.role }) })
        : await fetch(url, { method: 'DELETE', headers: { 'content-type': 'application/json' } });
      if (res.status === 401) return refreshSession();
      if (!res.ok) {
        setError(await errorOf(res));
        return;
      }
      if (c.kind === 'role') {
        setMembers((prev) => prev.map((m) => (m.id === c.member.id ? withRole(m, c.role) : m)));
      } else {
        setMembers((prev) => prev.filter((m) => m.id !== c.member.id));
        setFocusTo('members');
      }
    } catch {
      setError(GENERIC);
    } finally {
      setBusy(null);
    }
  };

  // OWNER is always assignable (promotion isn't an invite); otherwise the plan's roles, plus the member's own.
  const roleOptions = (m: Member) => ROLES.filter((r) => r === 'OWNER' || invitableRoles.includes(r) || r === m.role);

  return (
    <Card>
      <CardHeader>
        <h2 ref={membersHeading} tabIndex={-1} className={`flex items-center gap-2 text-base ${HEADING_CLASS}`}>
          <Users className="size-4" aria-hidden /> Members
        </h2>
      </CardHeader>
      <CardContent className="flex flex-col gap-6 text-sm">
        {initialMembers === null ? (
          <p className="text-muted-foreground">Couldn&apos;t load the member list. Refresh the page to try again.</p>
        ) : (
          <ul className="flex flex-col divide-y divide-border/60">
            {members.map((m) => {
              const self = m.user.id === viewerUserId;
              const editable = isOwner && !self;
              return (
                <li key={m.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                  <div className="min-w-0">
                    <p className="truncate font-medium">{m.user.name || m.user.email}{self && <span className="text-muted-foreground"> (you)</span>}</p>
                    <p className="truncate text-xs text-muted-foreground">{m.user.email}</p>
                    <p className="truncate text-xs text-muted-foreground">{appAccessSummary(m)}</p>
                  </div>
                  {editable ? (
                    <div className="flex items-center gap-2">
                      <select
                        aria-label={`Role for ${m.user.email}`}
                        className={SELECT_CLASS}
                        value={m.role}
                        disabled={busy === m.id}
                        onChange={(e) => setConfirm({ kind: 'role', member: m, role: e.target.value as Role })}
                      >
                        {roleOptions(m).map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
                      </select>
                      <Button
                        size="sm"
                        variant="ghost"
                        aria-label={`Remove ${m.user.email}`}
                        disabled={busy === m.id}
                        onClick={() => setConfirm({ kind: 'remove', member: m })}
                      >
                        Remove
                      </Button>
                    </div>
                  ) : (
                    <Badge variant="secondary">{ROLE_LABEL[m.role]}</Badge>
                  )}
                </li>
              );
            })}
          </ul>
        )}

        {canInviteAdmin && (
          <form
            noValidate
            className="flex flex-col gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              void sendInvite();
            }}
          >
            <p className="flex items-center gap-2 font-medium"><UserPlus className="size-4" aria-hidden /> Invite an admin</p>
            <p className="text-xs text-muted-foreground">Admins can open every app and manage settings. Invite teammates to an app from People with access.</p>
            <div className="flex flex-wrap items-end gap-2">
              <div className="flex min-w-56 flex-1 flex-col gap-1">
                <label htmlFor="admin-invite-email" className="text-xs font-medium">Admin email</label>
                <Input id="admin-invite-email" type="email" autoComplete="off" value={email} onChange={(e) => setEmail(e.target.value)} />
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
              {initialInvites === null ? "Couldn't load pending invites. Refresh the page to try again." : 'No pending invites.'}
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
            <AlertDialogTitle>
              {confirm?.kind === 'role'
                ? `Change ${confirm.member.user.email}'s role to ${ROLE_LABEL[confirm.role]}?`
                : `Remove ${confirm?.member.user.email ?? ''} from this workspace?`}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirm?.kind === 'role'
                ? 'Their access to every app in this workspace changes right away.'
                : 'They lose access to every app in this workspace right away. You can invite them again later.'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => { if (confirm) void runConfirmed(confirm); }}>
              {confirm?.kind === 'role' ? 'Change role' : 'Remove member'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
