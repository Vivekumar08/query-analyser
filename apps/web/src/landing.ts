export const LAST_APP_COOKIE = 'qa_last_app';
export type Landing = { kind: 'onboarding' } | { kind: 'app'; org: string; app: string } | { kind: 'org'; org: string };

export const NEW_ORG_HREF = '/onboarding?new=org';
export const ACCOUNT_HREF = '/dashboard/account';

/** Splits a decoded `qa_last_app` value into its org and app. */
function splitLastApp(lastApp: string | undefined): { org: string; app: string } | undefined {
  if (!lastApp) return undefined;
  const [org, app] = lastApp.split('/');
  return org && app ? { org, app } : undefined;
}

/**
 * Where /dashboard sends a visitor: their last app, the first app in any org,
 * the first org (its empty state), or onboarding when unverified or org-less.
 */

export function resolveLanding(input: {
  emailVerified: boolean;
  orgs: { slug: string; apps: { id: string }[] }[];
  lastApp: string | undefined;
}): Landing {
  if (!input.emailVerified) return { kind: 'onboarding' };
  const last = splitLastApp(input.lastApp);
  if (last) {
    const match = input.orgs.find((o) => o.slug === last.org);
    if (match && match.apps.some((a) => a.id === last.app)) return { kind: 'app', ...last };
  }
  for (const o of input.orgs) {
    const first = o.apps[0];
    if (first) return { kind: 'app', org: o.slug, app: first.id };
  }
  const firstOrg = input.orgs[0];
  if (firstOrg) return { kind: 'org', org: firstOrg.slug };
  return { kind: 'onboarding' };
}

/** Where /dashboard/<org> sends a visitor: the last app if it is in this org, else the first; null when it has none. */
export function resolveOrgLanding(input: { org: string; apps: { id: string }[]; lastApp: string | undefined }): string | null {
  const last = splitLastApp(input.lastApp);
  if (last && last.org === input.org && input.apps.some((a) => a.id === last.app)) return appPath(input.org, last.app);
  const first = input.apps[0];
  return first ? appPath(input.org, first.id) : null;
}

export function orgPath(org: string): string {
  return `/dashboard/${encodeURIComponent(org)}`;
}

export function appPath(org: string, app: string): string {
  return `/dashboard/${encodeURIComponent(org)}/${encodeURIComponent(app)}/queries`;
}

/** The cookie value is URI-encoded by RememberApp; a malformed one is treated as absent. */
export function readLastApp(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  try {
    return decodeURIComponent(raw);
  } catch {
    return undefined;
  }
}
