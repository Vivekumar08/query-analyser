import { cache } from 'react';
import { notFound, redirect } from 'next/navigation';
import { requireSession } from './auth';
import type { ApiResult } from './api';
import { getApp, listApps, listOrgs } from './dashboard-api';
import type { AppDetail, AppSummary, OrgSummary } from './dashboard-types';

export type ShellAccess = 'ok' | 'not-found' | 'unavailable';

/**
 * The org↔app pairing decision. The URL carries the org slug; the API keys
 * orgs by id, so the app must belong to the org whose slug is in the URL.
 * 403 and 404 both mean not-found: never hint whether something exists.
 */
export function checkShellAccess(
  orgs: Pick<OrgSummary, 'id' | 'slug'>[],
  orgSlug: string,
  appResult: ApiResult<Pick<AppDetail, 'orgId'>>,
): ShellAccess {
  if (!appResult.ok && appResult.status >= 500) return 'unavailable';
  const org = orgs.find((o) => o.slug === orgSlug);
  if (!org || !appResult.ok || appResult.data.orgId !== org.id) return 'not-found';
  return 'ok';
}

/**
 * Loads and authorises everything the shell needs for /dashboard/[org]/[app].
 *
 * EVERY page under [org]/[app] MUST call this (not just layout.tsx): Next
 * renders layouts and pages in parallel and does not re-run a layout on soft
 * navigation, so a page cannot assume the layout already vetted the pairing.
 * Wrapped in React `cache()` so the layout and the page share one fetch per
 * request.
 */
export const getShellContext = cache(async (org: string, app: string) => {
  const path = `/dashboard/${encodeURIComponent(org)}/${encodeURIComponent(app)}/queries`;
  const session = await requireSession(path);
  // Org/app reads need a verified email (403 otherwise).
  if (!session.user.emailVerifiedAt) redirect('/onboarding');
  const t = session.accessToken;
  const refresh = `/api/auth/refresh?next=${encodeURIComponent(path)}`;

  const [orgsRes, appRes] = await Promise.all([listOrgs(t), getApp(t, app)]);
  if (!orgsRes.ok) {
    if (orgsRes.status === 401) redirect(refresh);
    throw new Error('Could not load workspaces');
  }
  if (!appRes.ok && appRes.status === 401) redirect(refresh);

  const access = checkShellAccess(orgsRes.data, org, appRes);
  if (access === 'unavailable') throw new Error('Could not load app');
  if (access === 'not-found') notFound();
  // checkShellAccess guarantees both below.
  const currentOrg = orgsRes.data.find((o) => o.slug === org)!;
  if (!appRes.ok) notFound();

  const appsByOrg: Record<string, AppSummary[]> = Object.fromEntries(
    await Promise.all(orgsRes.data.map(async (o) => {
      const r = await listApps(t, o.id);
      if (r.ok) return [o.slug, r.data] as const;
      if (r.status === 401) redirect(refresh);
      // A suspended/inaccessible org is shown empty; an outage is not an empty org.
      if (r.status === 403 || r.status === 404) return [o.slug, []] as const;
      throw new Error('Could not load apps');
    })),
  );
  return { session, currentOrg, app: appRes.data, orgs: orgsRes.data, appsByOrg };
});
