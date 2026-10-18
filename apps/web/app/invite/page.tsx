import type { Metadata } from 'next';
import { AuthShell } from '@/components/marketing/AuthShell';
import { AcceptInviteClient } from '../_components/AcceptInviteClient';

// The URL carries a bearer token until the client scrubs it; keep it out of Referer meanwhile.
export const metadata: Metadata = { title: 'Accept invite', referrer: 'no-referrer' };

/**
 * Session-gated by proxy.ts (a signed-out visitor goes through login with
 * `next=/invite?token=…` and comes back). The token is deliberately NOT read
 * from searchParams here: it would become a server-rendered prop. The client
 * reads it from the address bar instead.
 */
export default function InvitePage() {
  return (
    <AuthShell title="Join the workspace" width="md">
      <AcceptInviteClient />
    </AuthShell>
  );
}
