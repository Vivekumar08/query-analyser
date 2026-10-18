import Link from 'next/link';
import { redirect } from 'next/navigation';
import { requireSession } from '@/src/auth';
import { getApp, listApps, listOrgs } from '@/src/dashboard-api';
import { resolveOnboardingStart } from '@/src/onboarding-state';
import { OnboardingFlow } from '@/components/onboarding/OnboardingFlow';

export default async function OnboardingPage({ searchParams }: { searchParams: Promise<{ org?: string }> }) {
  const { org: targetOrg } = await searchParams;
  const path = targetOrg ? `/onboarding?org=${encodeURIComponent(targetOrg)}` : '/onboarding';
  const session = await requireSession(path);
  const refresh = `/api/auth/refresh?next=${encodeURIComponent(path)}`;
  const verified = Boolean(session.user.emailVerifiedAt);
  // /v1/orgs requires a verified email; don't call it before then.
  const orgsRes = verified ? await listOrgs(session.accessToken) : null;
  if (orgsRes && !orgsRes.ok && orgsRes.status === 401) redirect(refresh);
  if (orgsRes && !orgsRes.ok) throw new Error('Could not load workspaces');
  const orgs = orgsRes?.ok ? orgsRes.data : [];
  // A returning user (reload, or back after leaving): find an app that never
  // reported. Skipped for "+ New app" (?org=), which always means a new app.
  let apps: { id: string; name: string; lastSeenAt: string | null }[] | undefined;
  if (verified && !targetOrg && orgs[0]) {
    const list = await listApps(session.accessToken, orgs[0].id);
    if (!list.ok && list.status === 401) redirect(refresh);
    if (!list.ok) throw new Error('Could not load apps');
    const details = await Promise.all(list.data.map((a) => getApp(session.accessToken, a.id)));
    // An app whose detail can't be read is treated as connected: never trap
    // the user in onboarding over a failed lookup.
    apps = list.data.map((a, i) => {
      const d = details[i]!;
      return { id: a.id, name: a.name, lastSeenAt: d.ok ? d.data.ingest.lastSeenAt : 'unknown' };
    });
  }
  const start = resolveOnboardingStart({ emailVerified: verified, orgs, targetOrg, apps });
  if (start === 'done') redirect('/dashboard');

  return (
    <main className="mx-auto grid min-h-screen max-w-4xl gap-10 px-6 py-16 md:grid-cols-[220px_1fr]">
      <Link href="/" className="text-[15px] font-semibold tracking-tight md:col-span-2">
        <span className="text-accent-text">◐</span> query·analyser
      </Link>
      <OnboardingFlow key={`${start.step}:${start.app?.id ?? ''}`} start={start} email={session.user.email} />
    </main>
  );
}
