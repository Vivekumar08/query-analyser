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
    <form onSubmit={onSubmit} className="flex w-full max-w-sm flex-col gap-4">
      {mode === 'signup' && (
        <label className="flex flex-col gap-1">
          <span className="text-sm font-medium">Name</span>
          <input name="name" required maxLength={100}
            className="rounded-md border border-slate-300 px-3 py-2" />
        </label>
      )}
      <label className="flex flex-col gap-1">
        <span className="text-sm font-medium">Email</span>
        <input name="email" type="email" required autoComplete="email"
          className="rounded-md border border-slate-300 px-3 py-2" />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-sm font-medium">Password</span>
        <input name="password" type="password" required minLength={12}
          autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
          className="rounded-md border border-slate-300 px-3 py-2" />
        {mode === 'signup' && (
          <span className="text-xs text-slate-500">At least 12 characters.</span>
        )}
      </label>

      {error && <p role="alert" className="text-sm text-red-600">{error}</p>}

      <button type="submit" disabled={pending}
        className="rounded-md bg-slate-900 px-4 py-2 text-white disabled:opacity-60">
        {pending
          ? (mode === 'signup' ? 'Creating your account…' : 'Signing in…')
          : (mode === 'signup' ? 'Create account' : 'Sign in')}
      </button>

      {mode === 'signup' && (
        // Signup measured 3.2-3.5s live because the API awaits the
        // verification mail. Saying so is the difference between a slow form
        // and a form that looks broken.
        <p className="text-xs text-slate-500">
          This takes a few seconds — we send your verification email before confirming.
        </p>
      )}
    </form>
  );
}
