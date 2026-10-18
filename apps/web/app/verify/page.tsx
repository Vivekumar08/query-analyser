import { AuthShell } from '@/components/marketing/AuthShell';
import { VerifyClient } from '../_components/VerifyClient';

export default async function VerifyPage({
  searchParams,
}: { searchParams: Promise<{ token?: string }> }) {
  const { token } = await searchParams;

  return (
    <AuthShell title="Confirm your email" width="md">
      {token
        ? <VerifyClient token={token} />
        : <p className="text-muted-foreground">This link is missing its token. Use the link from your email.</p>}
    </AuthShell>
  );
}
