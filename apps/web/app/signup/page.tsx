import Link from 'next/link';
import { AuthForm } from '../_components/AuthForm';

export default function SignupPage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-6 px-4">
      <h1 className="text-2xl font-semibold">Create your account</h1>
      <p className="text-sm text-slate-600">
        We&apos;ll email you a link to confirm your address. You&apos;ll need it before
        your ingest key appears.
      </p>
      <AuthForm mode="signup" next="/dashboard" />
      <p className="text-sm text-slate-600">
        Already have an account? <Link href="/login" className="underline">Sign in</Link>
      </p>
    </main>
  );
}
