'use client';

import { useEffect, useState } from 'react';
import { usePathname } from 'next/navigation';
import Link from 'next/link';
import { ContinueToInviteLink, usePendingInvite } from './ContinueToInvite';

export function VerifyClient({ token }: { token: string }) {
  const [state, setState] = useState<'pending' | 'done' | 'failed' | 'offline'>('pending');
  const pathname = usePathname();
  const invite = usePendingInvite();

  useEffect(() => {
    let cancelled = false;
    // POST, never GET. The API's confirm endpoints take the token in a body
    // because Fastify logs req.url — an invite token leaked exactly that way
    // in this project once.
    fetch('/api/auth/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token }),
    })
      .then((r) => { if (!cancelled) setState(r.ok ? 'done' : 'failed'); })
      // A thrown fetch means the request never reached the server — the
      // network failed, not the token. Telling an offline user their link
      // "expired" is simply wrong, so this gets its own state and copy.
      .catch(() => { if (!cancelled) setState('offline'); });
    // Scrub the token out of the address bar once the request has been
    // sent, so it doesn't linger in history or ride along in a Referer.
    // A plain History API call, not router.replace: that would re-run the
    // Server Component with no token and swap this whole screen out for the
    // "missing its token" message before the request above resolves.
    window.history.replaceState(null, '', pathname);
    return () => { cancelled = true; };
  }, [token, pathname]);

  if (state === 'pending') return <p className="text-muted-foreground">Confirming…</p>;
  if (state === 'done') {
    return (
      <>
        <p className="text-foreground">Your email is confirmed.</p>
        {/* A new user who signed up from an invite: lead them back to it, not into creating their own workspace. */}
        {invite && <ContinueToInviteLink path={invite} />}
        <Link href="/dashboard" className="font-medium text-accent-text underline underline-offset-4">Go to your dashboard</Link>
      </>
    );
  }
  if (state === 'offline') {
    return (
      <>
        <p className="text-foreground">We couldn&apos;t reach the server. Check your connection and try the link again.</p>
        <Link href="/login" className="font-medium text-accent-text underline underline-offset-4">Back to sign in</Link>
      </>
    );
  }
  return (
    <>
      <p className="text-foreground">That link didn&apos;t work — it may have expired or already been used.</p>
      <Link href="/login" className="font-medium text-accent-text underline underline-offset-4">Sign in to request a new one</Link>
    </>
  );
}
