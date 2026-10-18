'use client';
import { useState } from 'react';
import { Check } from 'lucide-react';
import { cn } from '@/lib/utils';
import { appPath } from '@/src/landing';
import { VerifyStep } from './VerifyStep';
import { OrgStep } from './OrgStep';
import { AppStep } from './AppStep';
import { InstallStep } from './InstallStep';

type Step = 'verify' | 'org' | 'app' | 'install';
const STEPS: { id: Step; label: string }[] = [
  { id: 'verify', label: 'Verify your email' },
  { id: 'org', label: 'Name your workspace' },
  { id: 'app', label: 'Create your first app' },
  { id: 'install', label: 'Install' },
];

export function OnboardingFlow({ start, email }: { start: { step: 'verify' | 'org' | 'app'; org?: string }; email: string }) {
  const [step, setStep] = useState<Step>(start.step);
  const [org, setOrg] = useState<string | undefined>(start.org);
  const [app, setApp] = useState<{ id: string; name: string } | null>(null);
  const [key, setKey] = useState<string | null>(null);
  const index = STEPS.findIndex((s) => s.id === step);

  return (
    <>
      <ol className="flex flex-col gap-4 text-sm">
        {STEPS.map((s, i) => (
          <li key={s.id} aria-current={s.id === step ? 'step' : undefined} className="flex items-center gap-3">
            <span className={cn('flex size-6 items-center justify-center rounded-full border text-xs',
              i < index && 'border-primary bg-primary text-primary-foreground',
              i === index && 'border-primary text-primary',
              i > index && 'text-muted-foreground')}>
              {i < index ? <Check className="size-3.5" aria-hidden /> : i + 1}
            </span>
            <span className={cn(i === index ? 'font-medium' : 'text-muted-foreground')}>{s.label}</span>
          </li>
        ))}
      </ol>
      <section>
        {step === 'verify' && <VerifyStep email={email} />}
        {step === 'org' && <OrgStep onCreated={(slug) => { setOrg(slug); setStep('app'); }} />}
        {step === 'app' && org && (
          <AppStep org={org} onCreated={(a, k) => { setApp(a); setKey(k); setStep('install'); }} />
        )}
        {step === 'install' && app && org && (
          <InstallStep appId={app.id} appName={app.name} ingestKey={key} doneHref={appPath(org, app.id)} />
        )}
      </section>
    </>
  );
}
