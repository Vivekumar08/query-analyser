'use client';
import { useState } from 'react';
import { Check } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { OnboardingStart } from '@/src/onboarding-state';
import { appPath } from '@/src/landing';
import { VerifyStep } from './VerifyStep';
import { OrgStep } from './OrgStep';
import { AppStep } from './AppStep';
import { InstallStep } from './InstallStep';
import { ContinueToInviteLink, usePendingInvite } from '@/app/_components/ContinueToInvite';

type Step = 'verify' | 'org' | 'app' | 'install';
const STEPS: { id: Step; label: string }[] = [
  { id: 'verify', label: 'Verify your email' },
  { id: 'org', label: 'Name your workspace' },
  { id: 'app', label: 'Create your first app' },
  { id: 'install', label: 'Install' },
];

export function OnboardingFlow({ start, email }: { start: OnboardingStart; email: string }) {
  const [step, setStep] = useState<Step>(start.step);
  const [org, setOrg] = useState<string | undefined>(start.org);
  const [app, setApp] = useState<{ id: string; name: string } | null>(start.app ?? null);
  const [key, setKey] = useState<string | null>(null);
  const [keyError, setKeyError] = useState<'forbidden' | 'failed' | null>(null);
  const index = STEPS.findIndex((s) => s.id === step);
  const invite = usePendingInvite();

  return (
    <>
      <ol className="flex flex-col gap-4 text-sm">
        {STEPS.map((s, i) => (
          <li key={s.id} aria-current={s.id === step ? 'step' : undefined} className="flex items-center gap-3">
            <span className={cn('flex size-6 items-center justify-center rounded-full border text-xs',
              i < index && 'border-accent-text bg-accent-text text-white',
              i === index && 'border-accent-text text-accent-text',
              i > index && 'text-muted-foreground')}>
              {i < index ? <Check className="size-3.5" aria-hidden /> : i + 1}
            </span>
            <span className={cn(i === index ? 'font-medium' : 'text-muted-foreground')}>{s.label}</span>
          </li>
        ))}
      </ol>
      <section className="flex flex-col gap-6">
        {invite && (
          // Signed up from an invite: joining that team is what they came for,
          // not creating a workspace of their own.
          <div className="flex flex-col gap-3 rounded-xl border border-border p-4 text-sm">
            <p>You were invited to a team. Join it instead of creating your own workspace.</p>
            <ContinueToInviteLink path={invite} />
          </div>
        )}
        {step === 'verify' && <VerifyStep email={email} />}
        {step === 'org' && (
          <OrgStep onCreated={(slug) => {
            // The org exists now: a reload of ?new=org must resume at its app
            // step, not offer to create a second org.
            window.history.replaceState(null, '', `/onboarding?org=${encodeURIComponent(slug)}`);
            setOrg(slug);
            setStep('app');
          }} />
        )}
        {step === 'app' && org && (
          <AppStep org={org} onCreated={(a, k, e) => { setApp(a); setKey(k); setKeyError(e); setStep('install'); }} />
        )}
        {step === 'install' && app && org && (
          <InstallStep appId={app.id} appName={app.name} ingestKey={key} keyError={keyError} doneHref={appPath(org, app.id)} />
        )}
      </section>
    </>
  );
}
