import Link from 'next/link';
import { FadeIn } from './_components/landing/FadeIn';
import { CopyButton } from './_components/landing/CopyButton';

const INSTALL = 'npm i @vivekumar08/query-analyser';

export default function Page() {
  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-20 px-4 py-20">
      <section className="flex flex-col gap-6">
        <h1 className="text-4xl font-semibold tracking-tight">
          Find the queries costing you the most time.
        </h1>
        <p className="text-lg text-slate-600">
          One line in your app. Query Analyser watches your database calls, groups them
          by shape, and tells you which ones to fix first.
        </p>

        <div className="flex items-center justify-between gap-4 rounded-lg bg-slate-900 px-4 py-3">
          <code className="font-mono text-sm text-slate-100">{INSTALL}</code>
          <CopyButton text={INSTALL} />
        </div>

        <div className="flex items-center gap-4">
          <Link href="/signup"
            className="rounded-md bg-slate-900 px-5 py-2.5 text-white">
            Get your ingest key
          </Link>
          <span className="text-sm text-slate-500">
            Free while in beta. Email confirmation required.
          </span>
        </div>
      </section>

      <FadeIn>
        <section className="flex flex-col gap-4">
          <h2 className="text-2xl font-semibold">What gets captured</h2>
          <ul className="flex flex-col gap-2 text-slate-600">
            <li>The query shape — model, operation, filter keys, sort keys.</li>
            <li>How often it runs, how long it takes, and the slowest observation.</li>
            <li>A latency histogram, so p95 and p99 are honest rather than guessed.</li>
            <li>One redacted sample per shape, to make a slow query recognisable.</li>
          </ul>
        </section>
      </FadeIn>

      <FadeIn delay={0.05}>
        <section className="flex flex-col gap-4">
          <h2 className="text-2xl font-semibold">What never leaves your app</h2>
          <p className="text-slate-600">
            Query values are redacted before anything is sent. We store the shape of a
            query and its timings — never the data it matched, and never the rows it
            returned. The sample you see in the dashboard has had its values removed in
            your process, before the network call.
          </p>
        </section>
      </FadeIn>

      <FadeIn delay={0.1}>
        <section className="flex flex-col gap-4">
          <h2 className="text-2xl font-semibold">Plans</h2>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="rounded-lg border border-slate-200 p-5">
              <h3 className="font-medium">Free</h3>
              <p className="mt-2 text-sm text-slate-600">
                One app, seven days of history. Everything the dashboard shows.
              </p>
            </div>
            <div className="rounded-lg border border-slate-200 p-5">
              <h3 className="font-medium">Team</h3>
              <p className="mt-2 text-sm text-slate-600">
                Coming soon — longer retention, more apps, and alerting.
              </p>
            </div>
          </div>
        </section>
      </FadeIn>

      <footer className="border-t border-slate-200 pt-8 text-sm text-slate-500">
        <Link href="/login" className="underline">Sign in</Link>
      </footer>
    </main>
  );
}
