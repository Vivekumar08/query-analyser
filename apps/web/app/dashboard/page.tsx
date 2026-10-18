import { requireSession } from '@/src/auth';
import { LogoutButton } from '../_components/LogoutButton';

/**
 * Placeholder until Plan C builds the real dashboard (Ruling B22). It exists
 * so that login, signup and email verification — which all land on
 * /dashboard — reach a real, session-gated page instead of a 404.
 * requireSession is the gate; proxy.ts only smooths the redirect.
 */
export default async function DashboardPage() {
  const session = await requireSession('/dashboard');

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-4 px-4">
      <h1 className="text-2xl font-semibold">Your dashboard is coming soon</h1>
      <p className="text-slate-600">
        You&apos;re signed in as <span className="font-medium">{session.user.email}</span>.
      </p>
      <LogoutButton />
    </main>
  );
}
