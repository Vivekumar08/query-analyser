import Link from 'next/link';
import { ForgotPasswordForm } from '../_components/ForgotPasswordForm';

export default function ForgotPasswordPage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-6 px-4">
      <h1 className="text-2xl font-semibold">Reset your password</h1>
      <p className="text-sm text-slate-600">
        Enter the email you signed up with and we&apos;ll send you a link to choose a new password.
      </p>
      <ForgotPasswordForm />
      <p className="text-sm text-slate-600">
        Remembered it? <Link href="/login" className="underline">Sign in</Link>
      </p>
    </main>
  );
}
