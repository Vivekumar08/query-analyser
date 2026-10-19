'use client';
import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { GENERIC, HEADING_CLASS, JSON_HEADERS, errorOf, refreshSession } from './request';

const NEW_MIN = 12;

/** The first local rule the form breaks, in the order the user reads them, or null. */
function localError(current: string, next: string, confirm: string): string | null {
  if (next.length < NEW_MIN) return 'Use at least 12 characters.';
  if (next !== confirm) return "The new passwords don't match.";
  if (next === current) return 'Choose a password different from your current one.';
  return null;
}

/**
 * Account → Password. The BFF stores the fresh session for this device; the
 * API revokes every other refresh token, so other devices drop off when their
 * 15-minute access token expires.
 */
export function PasswordCard() {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [saving, setSaving] = useState(false);
  const [changed, setChanged] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setChanged(false);
    const invalid = localError(current, next, confirm);
    if (invalid) {
      setError(invalid);
      return;
    }
    setError(null);
    setSaving(true);
    try {
      const res = await fetch('/api/me/password', {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ currentPassword: current, newPassword: next }),
      });
      if (res.status === 401) return refreshSession();
      if (!res.ok) {
        setError(await errorOf(res));
        return;
      }
      setCurrent('');
      setNext('');
      setConfirm('');
      setChanged(true);
    } catch {
      setError(GENERIC);
    } finally {
      setSaving(false);
    }
  };

  const field = (id: string, label: string, value: string, set: (v: string) => void, autoComplete: string) => (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-xs font-medium">{label}</label>
      <Input id={id} type="password" autoComplete={autoComplete} value={value} onChange={(e) => set(e.target.value)} />
    </div>
  );

  return (
    <Card>
      <CardHeader>
        <h2 className={HEADING_CLASS}>Password</h2>
        <p className="text-sm text-muted-foreground">Other devices are signed out within 15 minutes.</p>
      </CardHeader>
      <CardContent className="text-sm">
        <form
          noValidate
          className="flex max-w-sm flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          {field('password-current', 'Current password', current, setCurrent, 'current-password')}
          {field('password-new', 'New password', next, setNext, 'new-password')}
          {field('password-confirm', 'Confirm new password', confirm, setConfirm, 'new-password')}
          <Button type="submit" size="sm" className="h-9 self-start" disabled={saving}>
            {saving && <Loader2 className="size-4 animate-spin" aria-hidden />} Change password
          </Button>
          {changed && <p role="status">Password changed.</p>}
          {error && <p role="alert" className="text-destructive">{error}</p>}
        </form>
      </CardContent>
    </Card>
  );
}
