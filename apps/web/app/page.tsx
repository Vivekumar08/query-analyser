import Link from 'next/link';
import { FadeIn } from './_components/landing/FadeIn';
import { CopyButton } from '@/components/dashboard/CopyButton';
import { Accent } from '@/components/marketing/Accent';
import { Eyebrow } from '@/components/marketing/Eyebrow';
import { ExternalLink } from '@/components/marketing/ExternalLink';
import { GlassCard } from '@/components/marketing/GlassCard';
import { PillLink } from '@/components/marketing/PillLink';
import { ProductPreview } from '@/components/marketing/ProductPreview';

const INSTALL = 'npm i @vivekumar08/query-analyser';
const NPM = 'https://www.npmjs.com/package/@vivekumar08/query-analyser';
const GITHUB = 'https://github.com/Vivekumar08/query-analyser';

const STEPS = [
  { title: 'Install one line', body: 'Add init({ apiKey }) before your models load. Nothing else in your app changes.' },
  { title: 'We group by shape', body: 'Every call of 100 ms or more folds into its shape: model, operation, filter and sort keys.' },
  { title: 'Fix what matters first', body: 'Shapes ranked by the time they waste, honest p95 and p99, and the index to add.' },
];

function Wordmark() {
  return (
    <Link href="/" className="text-[15px] font-semibold tracking-tight">
      <span className="text-accent-text">◐</span> query·analyser
    </Link>
  );
}

function SectionHeading({ id, children }: { id?: string; children: React.ReactNode }) {
  return (
    <h2 id={id} className="mt-2 text-3xl font-semibold tracking-tight sm:text-[34px]">
      {children}
    </h2>
  );
}

export default function Page() {
  return (
    <div className="min-h-screen">
      <header className="mx-auto flex max-w-6xl items-center justify-between px-5 py-5 sm:px-8">
        <Wordmark />
        <nav className="flex items-center gap-5 text-sm text-muted-foreground">
          <a href="#how" className="hidden hover:text-foreground sm:inline">How it works</a>
          <ExternalLink href={NPM} className="hidden sm:inline">Docs</ExternalLink>
          <a href="#pricing" className="hidden hover:text-foreground sm:inline">Pricing</a>
          <Link href="/login" className="font-medium text-foreground">Sign in</Link>
        </nav>
      </header>

      <main className="mx-auto max-w-6xl px-5 sm:px-8">
        {/* Hero */}
        <section className="grid grid-cols-1 items-center gap-12 pt-10 pb-6 md:grid-cols-[1.15fr_1fr] md:pt-16 [&>*]:min-w-0">
          <div>
            <Eyebrow>For MongoDB · mongoose 8</Eyebrow>
            <h1 className="mt-4 text-[44px] leading-[1.03] font-semibold tracking-[-0.025em] sm:text-[56px]">
              Your slowest queries,
              <br />
              <Accent className="text-[1.08em]">quietly</Accent> found.
            </h1>
            <p className="mt-5 max-w-lg text-[17px] leading-relaxed text-muted-foreground">
              One line in your app. We group every slow call by shape and tell you which index to add first.
            </p>

            <div className="glass mt-7 flex max-w-md items-center justify-between gap-4 rounded-xl px-4 py-3">
              <code className="truncate font-mono text-[13.5px]">{INSTALL}</code>
              <CopyButton
                text={INSTALL}
                className="shrink-0 rounded-full px-3 py-1 text-xs font-medium text-accent-text hover:bg-accent"
              />
            </div>

            <div className="mt-5 flex flex-wrap items-center gap-4">
              <PillLink href="/signup">Get your key →</PillLink>
              <span className="text-sm text-caption">Free while in beta · verify your email to get your key</span>
            </div>
          </div>

          <ProductPreview />
        </section>

        {/* How it works */}
        <FadeIn>
          <section id="how" className="scroll-mt-8 pt-24">
            <Eyebrow>How it works</Eyebrow>
            <SectionHeading>
              Three steps, <Accent>no dashboards to wire up.</Accent>
            </SectionHeading>
            <ol className="mt-8 grid gap-4 md:grid-cols-3">
              {STEPS.map((s, i) => (
                <li key={s.title}>
                  <GlassCard className="h-full p-6">
                    <span className="flex size-7 items-center justify-center rounded-full bg-accent text-xs font-semibold text-accent-text">
                      {i + 1}
                    </span>
                    <h3 className="mt-4 font-semibold">{s.title}</h3>
                    <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{s.body}</p>
                  </GlassCard>
                </li>
              ))}
            </ol>
          </section>
        </FadeIn>

        {/* Shapes, never values */}
        <FadeIn>
          <section className="grid items-center gap-8 pt-24 md:grid-cols-2">
            <div>
              <Eyebrow>What leaves your app</Eyebrow>
              <SectionHeading>
                Shapes, <Accent>never values.</Accent>
              </SectionHeading>
              <p className="mt-4 max-w-md text-[15px] leading-relaxed text-muted-foreground">
                Key names, operator classes, durations and counts. No documents, no IDs, no customer data. Ever.
              </p>
            </div>
            <GlassCard className="p-5 font-mono text-[12.5px] leading-relaxed">
              <p className="text-caption">{'// you run'}</p>
              <p className="break-words">
                Order.find({'{'} email: <span className="text-[#A3476B]">&apos;priya@shop.in&apos;</span>, total: {'{'} $gte:{' '}
                <span className="text-[#A3476B]">500</span> {'}'} {'}'})
              </p>
              <p className="mt-4 text-caption">{'// we receive'}</p>
              <p className="break-words">
                {'{'} model: &apos;Order&apos;, op: &apos;find&apos;, filter: {'{'} email: <span className="text-accent-text">&apos;eq&apos;</span>, total:{' '}
                <span className="text-accent-text">&apos;range&apos;</span> {'}'} {'}'}
              </p>
            </GlassCard>
          </section>
        </FadeIn>

        {/* Pricing */}
        <FadeIn>
          <section id="pricing" className="scroll-mt-8 pt-24">
            <Eyebrow>Pricing</Eyebrow>
            <SectionHeading>
              Simple while we&apos;re <Accent>in beta.</Accent>
            </SectionHeading>
            <div className="mt-8 grid gap-4 sm:grid-cols-2">
              <GlassCard className="p-6">
                <h3 className="font-semibold">Free</h3>
                <p className="mt-2 text-sm text-muted-foreground">One app, seven days of history. Everything the dashboard shows.</p>
              </GlassCard>
              <GlassCard className="p-6">
                <h3 className="font-semibold">Team</h3>
                <p className="mt-2 text-sm text-muted-foreground">Coming soon — longer retention, more apps, and alerting.</p>
              </GlassCard>
            </div>
          </section>
        </FadeIn>

        {/* Closing CTA */}
        <FadeIn>
          <section className="py-24">
            <GlassCard className="px-6 py-12 text-center">
              <SectionHeading>
                Find your first slow query <Accent>today.</Accent>
              </SectionHeading>
              <p className="mx-auto mt-3 max-w-md text-sm text-muted-foreground">
                Sign up, verify your email, paste one line. Data arrives in about ten seconds.
              </p>
              <div className="mt-6">
                <PillLink href="/signup">Get your key →</PillLink>
              </div>
            </GlassCard>
          </section>
        </FadeIn>
      </main>

      <footer className="border-t border-border">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-5 py-6 text-sm text-caption sm:px-8">
          <span>
            <span className="text-accent-text">◐</span> query·analyser · MIT
          </span>
          <span className="flex gap-4">
            <ExternalLink href={GITHUB}>GitHub</ExternalLink>
            <ExternalLink href={NPM}>npm</ExternalLink>
            <ExternalLink href={NPM}>Docs</ExternalLink>
          </span>
        </div>
      </footer>
    </div>
  );
}
