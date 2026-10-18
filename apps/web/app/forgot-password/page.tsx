import { AuthShell } from '@/components/marketing/AuthShell';
import Link from 'next/link';
import { ForgotPasswordForm } from '../_components/ForgotPasswordForm';

export default function ForgotPasswordPage() {
  return (
    <AuthShell
      title="Reset your password"
      intro={<p>Enter the email you signed up with and we&apos;ll send you a link to choose a new password.</p>}
      footer={<p>Remembered it? <Link href="/login" className="font-medium text-accent-text underline underline-offset-4">Sign in</Link></p>}
    >
      <ForgotPasswordForm />
    </AuthShell>
  );
}
