export type OnboardingStep = 'verify' | 'org' | 'app' | 'install';

export function resolveOnboardingStart(input: {
  emailVerified: boolean;
  orgs: { slug: string }[];
  targetOrg?: string;
}): { step: 'verify' | 'org' | 'app'; org?: string } {
  if (!input.emailVerified) return { step: 'verify' };
  if (input.orgs.length === 0) return { step: 'org' };
  const target = input.orgs.find((o) => o.slug === input.targetOrg) ?? input.orgs[0]!;
  return { step: 'app', org: target.slug };
}
