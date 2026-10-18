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
        <p className="text-foreground">
          If an account exists for that address, we&apos;ve sent it a link to reset your
          password. Check your inbox — the link expires in an hour.
        </p>
        <Link href="/login" className="font-medium text-accent-text underline underline-offset-4">Back to sign in</Link>
      </>
    );
  }

  return (
    <form onSubmit={onSubmit} className="flex w-full flex-col gap-4">
      <label className="flex flex-col gap-1">
        <span className="text-sm font-medium">Email</span>
        <input name="email" type="email" required autoComplete="email" maxLength={200}
          className="rounded-xl border border-input bg-white/80 px-3.5 py-2.5 outline-none transition focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/30" />
      </label>

      {offline && (
        <p role="alert" className="text-sm text-red-600">
          We couldn&apos;t reach the server. Check your connection and try again.
        </p>
      )}

      <button type="submit" disabled={pending}
        className="rounded-full bg-primary px-5 py-2.5 font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-60">
        {pending ? 'Sending…' : 'Send reset link'}
      </button>
    </form>
  );
}
