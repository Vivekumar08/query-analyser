import Link from 'next/link';
import { GlassCard } from './GlassCard';

/**
 * Mist frame for the auth and email-link screens: wordmark home link above a
 * strong-glass card on the haze, so there's no plain-white seam between the
 * homepage and the dashboard.
 */
export function AuthShell({
  title,
  intro,
  children,
  footer,
  width = 'sm',
}: {
  title: React.ReactNode;
  intro?: React.ReactNode;
  children: React.ReactNode;
  footer?: React.ReactNode;
  width?: 'sm' | 'md';
}) {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-6 px-4 py-12">
      <Link href="/" className="text-[15px] font-semibold tracking-tight">
        <span className="text-accent-text">◐</span> query·analyser
      </Link>
      <GlassCard strong className={`w-full ${width === 'md' ? 'max-w-md' : 'max-w-sm'} p-7`}>
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {intro && <div className="mt-2 text-sm leading-relaxed text-muted-foreground">{intro}</div>}
        <div className="mt-6">{children}</div>
      </GlassCard>
      {footer && <div className="flex flex-col items-center gap-1 text-sm text-muted-foreground">{footer}</div>}
    </main>
  );
}
