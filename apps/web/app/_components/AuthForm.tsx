'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

interface Props {
  mode: 'login' | 'signup';
  next: string;
}

export function AuthForm({ mode, next }: Props) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setPending(true);
    setError(null);

    const form = new FormData(e.currentTarget);
    const payload: Record<string, string> = {
      email: String(form.get('email') ?? ''),
      password: String(form.get('password') ?? ''),
    };
    if (mode === 'signup') payload.name = String(form.get('name') ?? '');

    const res = await fetch(`/api/auth/${mode}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      setError(body.error ?? 'Something went wrong. Try again.');
      setPending(false);
      return;
    }

    router.push(next);
    router.refresh();
  }

  return (
    <form onSubmit={onSubmit} className="flex w-full flex-col gap-4">
      {mode === 'signup' && (
        <label className="flex flex-col gap-1">
          <span className="text-sm font-medium">Name</span>
          <input name="name" required maxLength={100}
            className="rounded-xl border border-input bg-white/80 px-3.5 py-2.5 outline-none transition focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/30" />
        </label>
      )}
      <label className="flex flex-col gap-1">
        <span className="text-sm font-medium">Email</span>
        <input name="email" type="email" required autoComplete="email"
          className="rounded-xl border border-input bg-white/80 px-3.5 py-2.5 outline-none transition focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/30" />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-sm font-medium">Password</span>
        <input name="password" type="password" required minLength={12}
          autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
          className="rounded-xl border border-input bg-white/80 px-3.5 py-2.5 outline-none transition focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/30" />
        {mode === 'signup' && (
          <span className="text-xs text-caption">At least 12 characters.</span>
        )}
      </label>

      {error && <p role="alert" className="text-sm text-red-600">{error}</p>}

      <button type="submit" disabled={pending}
        className="rounded-full bg-primary px-5 py-2.5 font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-60">
        {pending
          ? (mode === 'signup' ? 'Creating your account…' : 'Signing in…')
          : (mode === 'signup' ? 'Create account' : 'Sign in')}
      </button>

      {mode === 'signup' && (
        // Signup measured 3.2-3.5s live because the API awaits the
        // verification mail. Saying so is the difference between a slow form
        // and a form that looks broken.
        <p className="text-xs text-caption">
          This takes a few seconds — we send your verification email before confirming.
        </p>
      )}
    </form>
  );
}
