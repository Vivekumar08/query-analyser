import { isAdminRole, type Role } from './dashboard-types';

export type OnboardingStep = 'verify' | 'org' | 'app' | 'install';

export interface OnboardingStart {
  step: 'verify' | 'org' | 'app' | 'install';
  org?: string;
  /** Only with step 'install': the app awaiting its first batch. Never carries a key. */
  app?: { id: string; name: string };
}

/**
 * In order: unverified → verify; no orgs, or `newOrg` (`?new=org`) → org; a
 * `targetOrg` the user belongs to → its app step if ADMIN+, else done; a first
 * org below ADMIN → done (members can't create apps); then the first org's
 * apps decide between app, install and done.
 *
 * `apps` is the first org's apps with their last-seen time; pass it only when
 * there is no `targetOrg` or `newOrg`. Result `'done'` means there is nothing
 * for this user to set up and the caller should go to /dashboard.
 */
export function resolveOnboardingStart(input: {
  emailVerified: boolean;
  orgs: { slug: string; role: Role }[];
  targetOrg?: string;
  newOrg?: boolean;
  apps?: { id: string; name: string; lastSeenAt: string | null }[];
}): OnboardingStart | 'done' {
  if (!input.emailVerified) return { step: 'verify' };
  if (input.orgs.length === 0 || input.newOrg) return { step: 'org' };
  const target = input.orgs.find((o) => o.slug === input.targetOrg);
  if (target) return isAdminRole(target.role) ? { step: 'app', org: target.slug } : 'done';
  const first = input.orgs[0]!;
  if (!isAdminRole(first.role)) return 'done';
  if (input.targetOrg || !input.apps || input.apps.length === 0) return { step: 'app', org: first.slug };
  const pending = input.apps.find((a) => a.lastSeenAt === null);
  if (!pending) return 'done';
  return { step: 'install', org: first.slug, app: { id: pending.id, name: pending.name } };
}
