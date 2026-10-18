export const LAST_APP_COOKIE = 'qa_last_app';
export type Landing = { kind: 'onboarding' } | { kind: 'app'; org: string; app: string };

export function resolveLanding(input: {
  emailVerified: boolean;
  orgs: { slug: string; apps: { id: string }[] }[];
  lastApp: string | undefined;
}): Landing {
  if (!input.emailVerified) return { kind: 'onboarding' };
  if (input.lastApp) {
    const [org, app] = input.lastApp.split('/');
    const match = input.orgs.find((o) => o.slug === org);
    if (match && match.apps.some((a) => a.id === app)) return { kind: 'app', org: org!, app: app! };
  }
  for (const o of input.orgs) {
    const first = o.apps[0];
    if (first) return { kind: 'app', org: o.slug, app: first.id };
  }
  return { kind: 'onboarding' };
}

export function appPath(org: string, app: string): string {
  return `/dashboard/${encodeURIComponent(org)}/${encodeURIComponent(app)}/queries`;
}
