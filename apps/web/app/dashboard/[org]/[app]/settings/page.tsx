import { redirect } from 'next/navigation';
import { getShellContext } from '@/src/shell-context';
import { getSampleKey } from '@/src/dashboard-api';
import { PageHeader } from '@/components/dashboard/PageHeader';
import { FadeIn } from '@/components/dashboard/FadeIn';
import { SampleKeySection } from '@/components/settings/SampleKeySection';

export default async function SettingsPage({ params }: { params: Promise<{ org: string; app: string }> }) {
  const { org, app } = await params;
  const self = `/dashboard/${encodeURIComponent(org)}/${encodeURIComponent(app)}/settings`;
  // Authorises the org↔app pairing; the app ID (not the URL value) goes to the API.
  const ctx = await getShellContext(org, app);
  // App roles come from org membership (requireAppRole), so the org role decides.
  const canManage = ctx.currentOrg.role === 'OWNER' || ctx.currentOrg.role === 'ADMIN';

  const key = await getSampleKey(ctx.session.accessToken, ctx.app.id);
  if (!key.ok) {
    if (key.status === 401) redirect(`/api/auth/refresh?next=${encodeURIComponent(self)}`);
    throw new Error('Could not load settings');
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
          <section id="samples" aria-label="Real-value samples" className="scroll-mt-6">
            <SampleKeySection appId={ctx.app.id} canManage={canManage} initial={initial} />
          </section>
        </div>
      </FadeIn>
    </>
  );
}
