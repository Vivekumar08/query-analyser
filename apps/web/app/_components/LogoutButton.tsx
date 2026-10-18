'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

export function LogoutButton() {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);

  async function onClick() {
    setPending(true);
    setFailed(false);
    try {
      // JSON + same-origin fetch: the logout handler rejects anything else
      // (CSRF guard, Ruling B19). The browser adds the Origin header itself.
      const res = await fetch('/api/auth/logout', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      if (!res.ok) throw new Error(`logout failed with ${res.status}`);
    } catch {
      setFailed(true);
      setPending(false);
      return;
    }
    router.push('/');
    router.refresh();
  }

  return (
    <div className="flex flex-col items-start gap-2">
      <button type="button" onClick={onClick} disabled={pending}
        className="rounded-md border border-slate-300 px-4 py-2 disabled:opacity-60">
        {pending ? 'Signing out…' : 'Sign out'}
      </button>
      {failed && <p role="alert" className="text-sm text-red-600">Couldn&apos;t sign you out. Try again.</p>}
    </div>
  );
}
