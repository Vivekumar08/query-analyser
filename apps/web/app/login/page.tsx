import Link from 'next/link';
import { AuthForm } from '../_components/AuthForm';

export default async function LoginPage({
  searchParams,
}: { searchParams: Promise<{ next?: string }> }) {
  const { next } = await searchParams;
  const target = next && next.startsWith('/') && !next.startsWith('//') ? next : '/dashboard';

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
