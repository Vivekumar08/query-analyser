'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';

type State =
  | { kind: 'pending' }
  | { kind: 'done' }
  | { kind: 'missing' }
  | { kind: 'offline' }
  | { kind: 'failed'; message: string };

const GENERIC = 'Something went wrong. Please try again.';
const LINK_CLASS = 'font-medium text-accent-text underline underline-offset-4';

/**
 * Accepts the invite in `?token=`. The token is read here, in the browser —
 * never passed in as a server-rendered prop — scrubbed from the address bar
 * at once, and POSTed exactly once (the ref survives React StrictMode's
 * mount → unmount → mount, which would otherwise send it twice and turn the
 * second attempt into a confusing "already used").
 */
export function AcceptInviteClient() {
  const router = useRouter();
  const started = useRef(false);
  const [state, setState] = useState<State>({ kind: 'pending' });

  useEffect(() => {
    if (started.current) return;
    started.current = true;

    const token = new URLSearchParams(window.location.search).get('token');
    // A plain History API call, like /verify: out of history and any Referer
    // before anything else happens.
    window.history.replaceState(null, '', window.location.pathname);
    if (!token) {
      setState({ kind: 'missing' });
      return;
    }

    fetch('/api/invites/accept', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token }),
    })
      .then(async (res) => {
        if (res.ok) {
          setState({ kind: 'done' });
          router.replace('/dashboard');
          return;
        }
        if (res.status === 401) {
          // The access token lapsed after the proxy let us in: refresh and come back to accept.
          window.location.assign(`/api/auth/refresh?next=${encodeURIComponent(`/invite?token=${encodeURIComponent(token)}`)}`);
          return;
        }
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        setState({ kind: 'failed', message: data.error ?? GENERIC });
      })
      // A thrown fetch never reached the server: say so, not "expired".
      .catch(() => setState({ kind: 'offline' }));
  }, [router]);

  if (state.kind === 'pending') return <p role="status" className="text-muted-foreground">Joining the workspace…</p>;
  if (state.kind === 'done') return <p role="status" className="text-foreground">You&apos;re in. Taking you to your dashboard…</p>;
  if (state.kind === 'missing') {
    return (
      <>
        <p role="alert" className="text-foreground">This link is missing its token. Use the link from your invite email.</p>
        <Link href="/dashboard" className={LINK_CLASS}>Go to your dashboard</Link>
      </>
    );
  }
  if (state.kind === 'offline') {
    return <p role="alert" className="text-foreground">We couldn&apos;t reach the server. Check your connection and open the invite link again.</p>;
  }
  return (
    <>
      <p role="alert" className="text-foreground">{state.message}</p>
      <Link href="/dashboard" className={LINK_CLASS}>Go to your dashboard</Link>
    </>
  );
}
