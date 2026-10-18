import { AuthShell } from '@/components/marketing/AuthShell';
import { ResetClient } from '../_components/ResetClient';

export default async function ResetPasswordPage({
  searchParams,
}: { searchParams: Promise<{ token?: string }> }) {
  const { token } = await searchParams;

  return (
    <AuthShell title="Choose a new password" width="md">
      {token
        ? <ResetClient token={token} />
        : <p className="text-muted-foreground">This link is missing its token. Use the link from your email.</p>}
    </AuthShell>
  );
}
