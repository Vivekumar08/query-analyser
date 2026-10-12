import Link from 'next/link';
import { AuthForm } from '../_components/AuthForm';
import { safeNext } from '@/src/safe-next';

export default async function LoginPage({
  searchParams,
}: { searchParams: Promise<{ next?: string }> }) {
  const { next } = await searchParams;
  // A Server Component has no request origin to resolve against. The dummy
  // base is safe here because safeNext only ever returns pathname + search
  // (or the fallback) — an absolute URL like https://evil.com resolves to a
  // DIFFERENT origin than the dummy base and is rejected, while a path like
  // /dashboard?x=1 resolves against it and comes back as a bare path. Do not
  // "simplify" this to a prefix check — that's the exact bug this replaced.
  const target = safeNext(next, 'https://x.invalid', '/dashboard');

  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-6 px-4">
      <h1 className="text-2xl font-semibold">Sign in</h1>
      <AuthForm mode="login" next={target} />
      <p className="text-sm text-slate-600">
        No account? <Link href="/signup" className="underline">Create one</Link>
      </p>
    </main>
  );
}
