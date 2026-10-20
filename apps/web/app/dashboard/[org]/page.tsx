import { cookies } from 'next/headers';
import { notFound, redirect } from 'next/navigation';
import { requireSession } from '@/src/auth';
import { listApps, listOrgs } from '@/src/dashboard-api';
import { LAST_APP_COOKIE, orgPath, readLastApp, resolveOrgLanding } from '@/src/landing';
import { isSafeSegment } from '@/src/org-bff';
import { BareShell } from '@/components/dashboard/BareShell';
import { OrgHome } from '@/components/dashboard/OrgHome';

/**
 * /dashboard/<slug>: into the org's last-used (or first) app, else the org
 * home. The slug only picks one of the caller's own orgs from /v1/orgs; the
 * API is asked by org id and decides access. Static siblings such as
 * /dashboard/account win over this route; the API reserves those names as
 * slugs (RESERVED_SLUGS in apps/api/src/orgs/routes.ts), so keep them in step.
 */
export default async function OrgIndex({ params }: { params: Promise<{ org: string }> }) {
  const { org: slug } = await params;
  // Slugs are a single safe segment; anything else can't be one of ours.
  if (!isSafeSegment(slug)) notFound();
  const path = orgPath(slug);
  const session = await requireSession(path);
  // Org/app reads need a verified email (403 otherwise).
  if (!session.user.emailVerifiedAt) redirect('/onboarding');
  const t = session.accessToken;
  const refresh = `/api/auth/refresh?next=${encodeURIComponent(path)}`;

  const orgsRes = await listOrgs(t);
  if (!orgsRes.ok) {
    if (orgsRes.status === 401) redirect(refresh);
    throw new Error('Could not load workspaces');
  }
  const org = orgsRes.data.find((o) => o.slug === slug);
  if (!org) notFound();

  const appsRes = await listApps(t, org.id);
  let suspended = false;
  if (!appsRes.ok) {
    if (appsRes.status === 401) redirect(refresh);
    // A suspended org still gets a page that says so: /dashboard can land
    // here, and a 404 or a redirect would strand or loop the visitor.
    else if (appsRes.status === 403) suspended = true;
    else if (appsRes.status === 404) notFound();
    else throw new Error('Could not load apps');
  } else {
    const target = resolveOrgLanding({
      org: slug,
      apps: appsRes.data,
      lastApp: readLastApp((await cookies()).get(LAST_APP_COOKIE)?.value),
    });
    if (target) redirect(target);
  }

  const toRef = (o: (typeof orgsRes.data)[number]) => ({ slug: o.slug, name: o.name, role: o.role });
  return (
    <BareShell>
      <OrgHome org={toRef(org)} orgs={orgsRes.data.map(toRef)} suspended={suspended} />
    </BareShell>
  );
}
