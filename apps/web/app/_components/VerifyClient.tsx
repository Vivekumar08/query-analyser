'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';

export function VerifyClient({ token }: { token: string }) {
  const [state, setState] = useState<'pending' | 'done' | 'failed'>('pending');

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
      .catch(() => { if (!cancelled) setState('failed'); });
    return () => { cancelled = true; };
  }, [token]);

  if (state === 'pending') return <p className="text-slate-600">Confirming…</p>;
  if (state === 'done') {
    return (
      <>
        <p className="text-slate-800">Your email is confirmed.</p>
        <Link href="/dashboard" className="underline">Go to your dashboard</Link>
      </>
    );
  }
  return (
    <>
      <p className="text-slate-800">That link didn&apos;t work — it may have expired or already been used.</p>
      <Link href="/login" className="underline">Sign in to request a new one</Link>
    </>
  );
}
