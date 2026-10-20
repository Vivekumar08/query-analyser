import { redirect } from 'next/navigation';
import { requireSession } from '@/src/auth';
import { listOrgs } from '@/src/dashboard-api';
import { ACCOUNT_HREF } from '@/src/landing';
import { BareShell } from '@/components/dashboard/BareShell';
import { ProfileCard } from '@/components/account/ProfileCard';
import { PasswordCard } from '@/components/account/PasswordCard';
import { OrganisationsCard } from '@/components/account/OrganisationsCard';

/**
 * /dashboard/account: name, password and the user's organisations, in the
 * bare shell (no app sidebar). A static sibling of /dashboard/[org], which
 * is why the API reserves `account` as an org slug.
 */
export default async function AccountPage() {
  const session = await requireSession(ACCOUNT_HREF);
  // Org reads need a verified email (403 otherwise), as on every /dashboard route.
  if (!session.user.emailVerifiedAt) redirect('/onboarding');

  const orgsRes = await listOrgs(session.accessToken);
  if (!orgsRes.ok) {
    if (orgsRes.status === 401) redirect(`/api/auth/refresh?next=${encodeURIComponent(ACCOUNT_HREF)}`);
    throw new Error('Could not load workspaces');
  }

  return (
    <BareShell back={{ href: '/dashboard', label: '← Back to dashboard' }}>
      <h1 className="text-2xl font-semibold tracking-tight">Account</h1>
      <ProfileCard
        name={session.user.name}
        email={session.user.email}
        verified={Boolean(session.user.emailVerifiedAt)}
      />
      <PasswordCard />
      <OrganisationsCard orgs={orgsRes.data.map(({ id, slug, name, role }) => ({ id, slug, name, role }))} />
    </BareShell>
  );
}
