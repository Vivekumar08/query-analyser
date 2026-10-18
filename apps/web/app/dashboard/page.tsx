import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { requireSession } from '@/src/auth';
import { listApps, listOrgs } from '@/src/dashboard-api';
import { LAST_APP_COOKIE, appPath, resolveLanding } from '@/src/landing';

/** Where a signed-in visitor belongs: their last app, their first app, or onboarding. */
export default async function DashboardIndex() {
  const session = await requireSession('/dashboard');
  // Every org/app read requires a verified email (403 otherwise), so an
  // unverified visitor is routed on without asking the API.
  if (!session.user.emailVerifiedAt) redirect('/onboarding');

  const orgsRes = await listOrgs(session.accessToken);
  if (!orgsRes.ok) {
    if (orgsRes.status === 401) redirect('/api/auth/refresh?next=%2Fdashboard');
    // An outage must not look like "you have no workspace".
    throw new Error('orgs unavailable');
  }

  const withApps = await Promise.all(
    orgsRes.data.map(async (o) => {
      // The API's `:org` is the org id; the slug is only for URLs.
      const apps = await listApps(session.accessToken, o.id);
      if (!apps.ok) {
        // A suspended org (403) or one we lost access to (404) is skipped;
        // anything else is an outage, not an empty org.
        if (apps.status === 403 || apps.status === 404) return { slug: o.slug, apps: [] };
        throw new Error('apps unavailable');
      }
      return { slug: o.slug, apps: apps.data };
    }),
  );
  const landing = resolveLanding({
    emailVerified: true,
    orgs: withApps,
    lastApp: (await cookies()).get(LAST_APP_COOKIE)?.value,
  });
  redirect(landing.kind === 'onboarding' ? '/onboarding' : appPath(landing.org, landing.app));
}
