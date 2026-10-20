import { notFound, redirect } from 'next/navigation';
import { getShellContext } from '@/src/shell-context';
import { getSampleKey, listInvites, listMembers } from '@/src/dashboard-api';
import { isAdminRole } from '@/src/dashboard-types';
import { PageHeader } from '@/components/dashboard/PageHeader';
import { FadeIn } from '@/components/dashboard/FadeIn';
import { SampleKeySection } from '@/components/settings/SampleKeySection';
import { Members } from '@/components/settings/Members';

export default async function SettingsPage({ params }: { params: Promise<{ org: string; app: string }> }) {
  const { org, app } = await params;
  const self = `/dashboard/${encodeURIComponent(org)}/${encodeURIComponent(app)}/settings`;
  // Authorises the org↔app pairing; the app ID (not the URL value) goes to the API.
  const ctx = await getShellContext(org, app);
  // Settings are ADMIN+ only: anyone else gets the not-found page, before any fetch.
  if (!isAdminRole(ctx.currentOrg.role)) notFound();

  const t = ctx.session.accessToken;
  const orgId = ctx.currentOrg.id;
  const [key, members, invites] = await Promise.all([
    getSampleKey(t, ctx.app.id),
    listMembers(t, orgId),
    listInvites(t, orgId),
  ]);
  if (!key.ok) {
    if (key.status === 401) redirect(`/api/auth/refresh?next=${encodeURIComponent(self)}`);
    throw new Error('Could not load settings');
  }
  if ((!members.ok && members.status === 401) || (!invites.ok && invites.status === 401)) {
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
              initialMembers={members.ok ? members.data : null}
              initialInvites={invites.ok ? invites.data : null}
            />
          </section>
          <section id="samples" aria-label="Real-value samples" className="scroll-mt-6">
            <SampleKeySection appId={ctx.app.id} canManage initial={initial} />
          </section>
        </div>
      </FadeIn>
    </>
  );
}
