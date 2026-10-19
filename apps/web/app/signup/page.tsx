import { AuthShell } from '@/components/marketing/AuthShell';
import Link from 'next/link';
import { AuthForm } from '../_components/AuthForm';
import { safeNext } from '@/src/safe-next';

export default async function SignupPage({
  searchParams,
}: { searchParams: Promise<{ next?: string }> }) {
  const { next } = await searchParams;
  // Same dummy-base reasoning as /login: safeNext only ever returns a
  // single-slash same-origin path or the fallback. An invitee arrives here
  // with next=/invite?token=… and goes straight back to it after signup.
  const target = safeNext(next, 'https://x.invalid', '/dashboard');
  const carried = safeNext(next, 'https://x.invalid', '');
  const loginHref = carried ? `/login?next=${encodeURIComponent(carried)}` : '/login';

  return (
    <AuthShell
      title="Create your account"
      intro={<p>We&apos;ll email you a link to confirm your address. You&apos;ll need it before your ingest key appears.</p>}
      footer={<p>Already have an account? <Link href={loginHref} className="font-medium text-accent-text underline underline-offset-4">Sign in</Link></p>}
    >
      <AuthForm mode="signup" next={target} />
    </AuthShell>
  );
}
