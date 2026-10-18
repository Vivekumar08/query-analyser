'use client';

import { useEffect, useState } from 'react';
import { usePathname } from 'next/navigation';
import Link from 'next/link';

export function ResetClient({ token }: { token: string }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const pathname = usePathname();

  useEffect(() => {
    // Scrub the token out of the address bar once this screen holds it in
    // component state, so it doesn't linger in history or ride along in a
    // Referer header while the form is sitting unsubmitted. A plain History
    // API call, not router.replace: that would re-run the Server Component
    // with no token and swap this screen out for the "missing its token"
    // message.
    window.history.replaceState(null, '', pathname);
  }, [pathname]);

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
        <p className="text-foreground">
          Your password is changed. Every other session has been signed out.
        </p>
        <Link href="/login" className="font-medium text-accent-text underline underline-offset-4">Sign in</Link>
      </>
    );
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4">
      <label className="flex flex-col gap-1">
        <span className="text-sm font-medium">New password</span>
        <input name="password" type="password" required minLength={12}
          autoComplete="new-password"
          className="rounded-xl border border-input bg-white/80 px-3.5 py-2.5 outline-none transition focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/30" />
        <span className="text-xs text-caption">At least 12 characters.</span>
      </label>

      {error && <p role="alert" className="text-sm text-red-600">{error}</p>}

      <button type="submit" disabled={pending}
        className="rounded-full bg-primary px-5 py-2.5 font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-60">
        {pending ? 'Saving…' : 'Set new password'}
      </button>
    </form>
  );
}
