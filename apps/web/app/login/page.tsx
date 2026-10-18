import Link from 'next/link';
import { AuthForm } from '../_components/AuthForm';
import { safeNext } from '@/src/safe-next';

export default async function LoginPage({
  searchParams,
}: { searchParams: Promise<{ next?: string }> }) {
  const { next } = await searchParams;
  // A Server Component has no request origin to resolve against. The dummy
  // base is safe here because safeNext only ever returns a single-slash path
  // (pathname + search) or the fallback: anything resolving to another origin,
  // containing a backslash, or whose resolved pathname starts with `//`
  // (dot-segment tricks like /.//evil.com) is rejected. The result goes
  // straight to AuthForm's router.push, which re-parses it — so it must be
  // a value that re-parses on THIS origin, which is exactly what safeNext
  // guarantees. Do not "simplify" this to a prefix check.
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
