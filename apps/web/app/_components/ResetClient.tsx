'use client';

import { useState } from 'react';
import Link from 'next/link';

export function ResetClient({ token }: { token: string }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setPending(true);
    setError(null);

    const form = new FormData(e.currentTarget);
    // POST, never GET — same reason as the verify page: the API takes the
    // token in a body because Fastify logs req.url.
    const res = await fetch('/api/auth/reset', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token, password: String(form.get('password') ?? '') }),
    });

    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      setError(body.error ?? 'That link didn’t work — it may have expired or already been used.');
      setPending(false);
      return;
    }
    setDone(true);
  }

  if (done) {
    return (
      <>
        <p className="text-slate-800">
          Your password is changed. Every other session has been signed out.
        </p>
        <Link href="/login" className="underline">Sign in</Link>
      </>
    );
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4">
      <label className="flex flex-col gap-1">
        <span className="text-sm font-medium">New password</span>
        <input name="password" type="password" required minLength={12}
          autoComplete="new-password"
          className="rounded-md border border-slate-300 px-3 py-2" />
        <span className="text-xs text-slate-500">At least 12 characters.</span>
      </label>

      {error && <p role="alert" className="text-sm text-red-600">{error}</p>}

      <button type="submit" disabled={pending}
        className="rounded-md bg-slate-900 px-4 py-2 text-white disabled:opacity-60">
        {pending ? 'Saving…' : 'Set new password'}
      </button>
    </form>
  );
}
