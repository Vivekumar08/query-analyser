'use client';

import { useState } from 'react';
import Link from 'next/link';

export function ForgotPasswordForm() {
  const [pending, setPending] = useState(false);
  const [sent, setSent] = useState(false);
  const [offline, setOffline] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setPending(true);
    setOffline(false);

    const form = new FormData(e.currentTarget);
    try {
      await fetch('/api/auth/password-request', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: String(form.get('email') ?? '') }),
      });
    } catch {
      // Only a failure to reach THIS site lands here; nothing about the
      // account is known, so retrying is the one useful thing to suggest.
      setOffline(true);
      setPending(false);
      return;
    }
    // Same confirmation whatever the response: whether an account exists
    // for the address must not be visible here (anti-enumeration).
    setSent(true);
  }

  if (sent) {
    return (
      <>
        <p className="text-slate-800">
          If an account exists for that address, we&apos;ve sent it a link to reset your
          password. Check your inbox — the link expires in an hour.
        </p>
        <Link href="/login" className="underline">Back to sign in</Link>
      </>
    );
  }

  return (
    <form onSubmit={onSubmit} className="flex w-full max-w-sm flex-col gap-4">
      <label className="flex flex-col gap-1">
        <span className="text-sm font-medium">Email</span>
        <input name="email" type="email" required autoComplete="email" maxLength={200}
          className="rounded-md border border-slate-300 px-3 py-2" />
      </label>

      {offline && (
        <p role="alert" className="text-sm text-red-600">
          We couldn&apos;t reach the server. Check your connection and try again.
        </p>
      )}

      <button type="submit" disabled={pending}
        className="rounded-md bg-slate-900 px-4 py-2 text-white disabled:opacity-60">
        {pending ? 'Sending…' : 'Send reset link'}
      </button>
    </form>
  );
}
