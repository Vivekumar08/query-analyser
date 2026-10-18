import type { AppSummary } from '@/src/dashboard-types';
import { appPath } from '@/src/landing';

/** Groups apps under their org. Keys of `appsByOrg` and `current.org` are org slugs (the URL form). */
export function groupForSwitcher(
  orgs: { slug: string; name: string }[],
  appsByOrg: Record<string, AppSummary[]>,
  current: { org: string; app: string },
) {
  return orgs.map((org) => ({
    org,
    apps: (appsByOrg[org.slug] ?? []).map((a) => ({
      id: a.id,
      name: a.name,
      env: a.env,
      href: appPath(org.slug, a.id),
      current: org.slug === current.org && a.id === current.app,
    })),
  }));
}
