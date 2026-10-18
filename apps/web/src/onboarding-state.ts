export type OnboardingStep = 'verify' | 'org' | 'app' | 'install';

export interface OnboardingStart {
  step: 'verify' | 'org' | 'app' | 'install';
  org?: string;
  /** Only with step 'install': the app awaiting its first batch. Never carries a key. */
  app?: { id: string; name: string };
}

/**
 * `apps` is the first org's apps with their last-seen time; pass it only when
 * there is no `targetOrg`. Result `'done'` means everything is connected and
 * the caller should go to /dashboard.
 */
export function resolveOnboardingStart(input: {
  emailVerified: boolean;
  orgs: { slug: string }[];
  targetOrg?: string;
  apps?: { id: string; name: string; lastSeenAt: string | null }[];
}): OnboardingStart | 'done' {
  if (!input.emailVerified) return { step: 'verify' };
  if (input.orgs.length === 0) return { step: 'org' };
  const target = input.orgs.find((o) => o.slug === input.targetOrg);
  if (target) return { step: 'app', org: target.slug };
  const first = input.orgs[0]!;
  if (input.targetOrg || !input.apps || input.apps.length === 0) return { step: 'app', org: first.slug };
  const pending = input.apps.find((a) => a.lastSeenAt === null);
  if (!pending) return 'done';
  return { step: 'install', org: first.slug, app: { id: pending.id, name: pending.name } };
}
