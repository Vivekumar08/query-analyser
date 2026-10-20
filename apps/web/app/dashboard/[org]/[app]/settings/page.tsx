import { notFound, redirect } from 'next/navigation';
import { getShellContext } from '@/src/shell-context';
import { getAppAccess, getSampleKey, listInvites, listMembers } from '@/src/dashboard-api';
import { isAdminRole } from '@/src/dashboard-types';
import { PageHeader } from '@/components/dashboard/PageHeader';
import { FadeIn } from '@/components/dashboard/FadeIn';
import { SampleKeySection } from '@/components/settings/SampleKeySection';
import { Members } from '@/components/settings/Members';
import { People } from '@/components/settings/People';
import { DeleteApp } from '@/components/settings/DeleteApp';

export default async function SettingsPage({ params }: { params: Promise<{ org: string; app: string }> }) {
  const { org, app } = await params;
  const self = `/dashboard/${encodeURIComponent(org)}/${encodeURIComponent(app)}/settings`;
  // Authorises the org↔app pairing; the app ID (not the URL value) goes to the API.
  const ctx = await getShellContext(org, app);
  // Settings are ADMIN+ only: anyone else gets the not-found page, before any fetch.
  if (!isAdminRole(ctx.currentOrg.role)) notFound();

  const t = ctx.session.accessToken;
  const orgId = ctx.currentOrg.id;
  const [key, members, invites, access] = await Promise.all([
    getSampleKey(t, ctx.app.id),
    listMembers(t, orgId),
    listInvites(t, orgId),
    getAppAccess(t, ctx.app.id),
  ]);
  if (!key.ok) {
    if (key.status === 401) redirect(`/api/auth/refresh?next=${encodeURIComponent(self)}`);
    throw new Error('Could not load settings');
  }
  if ([members, invites, access].some((r) => !r.ok && r.status === 401)) {
    redirect(`/api/auth/refresh?next=${encodeURIComponent(self)}`);
  }
  // Only the status and the public key reach the client; the wrapped key stays here.
  const initial = key.data.enabled && key.data.publicKey
    ? { enabled: true, publicKey: key.data.publicKey }
    : { enabled: false };
  const invitableRoles = ctx.currentOrg.limits.invitableRoles;

  return (
    <>
      <PageHeader title="Settings" crumbs={[{ label: org }, { label: ctx.app.name }, { label: 'Settings' }]} />
      <FadeIn>
        <div className="flex max-w-3xl flex-col gap-6 p-6">
          <section id="people" aria-label="People with access" className="scroll-mt-6">
            <People orgId={orgId} appId={ctx.app.id} invitableRoles={invitableRoles} initial={access.ok ? access.data : null} />
          </section>
          <section id="members" aria-label="Members" className="scroll-mt-6">
            <Members
              orgId={orgId}
              viewerRole={ctx.currentOrg.role}
              viewerUserId={ctx.session.user.id}
              invitableRoles={invitableRoles}
              // A failed list renders as "couldn't load" in the section, not as a broken page.
              initialMembers={members.ok ? members.data : null}
              // App invites are listed under People with access (for their app); only org-wide ones here.
              initialInvites={invites.ok ? invites.data.filter((i) => i.appId === null) : null}
            />
          </section>
          <section id="samples" aria-label="Real-value samples" className="scroll-mt-6">
            <SampleKeySection appId={ctx.app.id} canManage initial={initial} />
          </section>
          <section id="danger" aria-label="Danger zone" className="scroll-mt-6">
            <DeleteApp appId={ctx.app.id} appName={ctx.app.name} orgSlug={ctx.currentOrg.slug} />
          </section>
        </div>
      </FadeIn>
    </>
  );
}
