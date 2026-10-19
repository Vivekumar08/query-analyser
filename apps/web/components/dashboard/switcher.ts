import type { AppSummary, Role } from '@/src/dashboard-types';
import { appPath, orgPath } from '@/src/landing';

/** The caller's organisations for the switcher; `currentOrg` is the slug in the URL. */
export function orgsForSwitcher(orgs: { slug: string; name: string; role: Role }[], currentOrg: string) {
  return orgs.map((o) => ({ slug: o.slug, name: o.name, role: o.role, href: orgPath(o.slug), current: o.slug === currentOrg }));
}

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
