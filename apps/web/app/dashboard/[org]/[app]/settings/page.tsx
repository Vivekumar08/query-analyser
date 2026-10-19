import { redirect } from 'next/navigation';
import { getShellContext } from '@/src/shell-context';
import { getSampleKey, listInvites, listMembers } from '@/src/dashboard-api';
import { PageHeader } from '@/components/dashboard/PageHeader';
import { FadeIn } from '@/components/dashboard/FadeIn';
import { SampleKeySection } from '@/components/settings/SampleKeySection';
import { Members } from '@/components/settings/Members';

export default async function SettingsPage({ params }: { params: Promise<{ org: string; app: string }> }) {
  const { org, app } = await params;
  const self = `/dashboard/${encodeURIComponent(org)}/${encodeURIComponent(app)}/settings`;
  // Authorises the org↔app pairing; the app ID (not the URL value) goes to the API.
  const ctx = await getShellContext(org, app);
  // App roles come from org membership (requireAppRole), so the org role decides.
  const canManage = ctx.currentOrg.role === 'OWNER' || ctx.currentOrg.role === 'ADMIN';

  const t = ctx.session.accessToken;
  const orgId = ctx.currentOrg.id;
  // Members and invites need ADMIN; below that the API refuses, so don't ask.
  const [key, members, invites] = await Promise.all([
    getSampleKey(t, ctx.app.id),
    canManage ? listMembers(t, orgId) : null,
    canManage ? listInvites(t, orgId) : null,
  ]);
  if (!key.ok) {
    if (key.status === 401) redirect(`/api/auth/refresh?next=${encodeURIComponent(self)}`);
    throw new Error('Could not load settings');
  }
  if ((members && !members.ok && members.status === 401) || (invites && !invites.ok && invites.status === 401)) {
    redirect(`/api/auth/refresh?next=${encodeURIComponent(self)}`);
  }
  // Only the status and the public key reach the client; the wrapped key stays here.
  const initial = key.data.enabled && key.data.publicKey
    ? { enabled: true, publicKey: key.data.publicKey }
    : { enabled: false };

  return (
    <>
      <PageHeader title="Settings" crumbs={[{ label: org }, { label: ctx.app.name }, { label: 'Settings' }]} />
      <FadeIn>
        <div className="flex max-w-3xl flex-col gap-6 p-6">
          <section id="members" aria-label="Members" className="scroll-mt-6">
            <Members
              orgId={orgId}
              viewerRole={ctx.currentOrg.role}
              viewerUserId={ctx.session.user.id}
              // A failed list renders as "couldn't load" in the section, not as a broken page.
              initialMembers={members?.ok ? members.data : null}
              initialInvites={invites?.ok ? invites.data : null}
            />
          </section>
          <section id="samples" aria-label="Real-value samples" className="scroll-mt-6">
            <SampleKeySection appId={ctx.app.id} canManage={canManage} initial={initial} />
          </section>
        </div>
      </FadeIn>
    </>
  );
}
