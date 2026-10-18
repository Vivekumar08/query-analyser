import { requireSession } from '@/src/auth';
import { listOrgs } from '@/src/dashboard-api';
import { resolveOnboardingStart } from '@/src/onboarding-state';
import { OnboardingFlow } from '@/components/onboarding/OnboardingFlow';

export default async function OnboardingPage({ searchParams }: { searchParams: Promise<{ org?: string }> }) {
  const { org: targetOrg } = await searchParams;
  const session = await requireSession(targetOrg ? `/onboarding?org=${encodeURIComponent(targetOrg)}` : '/onboarding');
  const verified = Boolean(session.user.emailVerifiedAt);
  // /v1/orgs requires a verified email; don't call it before then.
  const orgsRes = verified ? await listOrgs(session.accessToken) : null;
  if (orgsRes && !orgsRes.ok) throw new Error('Could not load workspaces');
  const orgs = orgsRes?.ok ? orgsRes.data : [];
  const start = resolveOnboardingStart({ emailVerified: verified, orgs, targetOrg });

  return (
    <main className="mx-auto grid min-h-screen max-w-4xl gap-10 px-6 py-16 md:grid-cols-[220px_1fr]">
      <OnboardingFlow key={start.step} start={start} email={session.user.email} />
    </main>
  );
}
