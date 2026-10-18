import { AuthShell } from '@/components/marketing/AuthShell';
import Link from 'next/link';
import { AuthForm } from '../_components/AuthForm';

export default function SignupPage() {
  return (
    <AuthShell
      title="Create your account"
      intro={<p>We&apos;ll email you a link to confirm your address. You&apos;ll need it before your ingest key appears.</p>}
      footer={<p>Already have an account? <Link href="/login" className="font-medium text-accent-text underline underline-offset-4">Sign in</Link></p>}
    >
      <AuthForm mode="signup" next="/dashboard" />
    </AuthShell>
  );
}
