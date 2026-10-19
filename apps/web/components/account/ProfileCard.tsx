'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { GENERIC, HEADING_CLASS, JSON_HEADERS, errorOf, refreshSession } from './request';

const NAME_MAX = 100;
const NAME_RULE = 'Enter a name between 1 and 100 characters.';

/** Account → Profile: rename yourself; the email is shown but can't be changed here. */
export function ProfileCard({ name, email, verified }: { name: string; email: string; verified: boolean }) {
  const router = useRouter();
  const [value, setValue] = useState(name);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    const next = value.trim();
    setSaved(false);
    if (next.length < 1 || next.length > NAME_MAX) {
      setError(NAME_RULE);
      return;
    }
    setError(null);
    setSaving(true);
    try {
      const res = await fetch('/api/me', { method: 'PATCH', headers: JSON_HEADERS, body: JSON.stringify({ name: next }) });
      if (res.status === 401) return refreshSession();
      if (!res.ok) {
        setError(await errorOf(res));
        return;
      }
      setValue(next);
      setSaved(true);
      // The sidebar and switcher read the name from the server.
      router.refresh();
    } catch {
      setError(GENERIC);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <h2 className={HEADING_CLASS}>Profile</h2>
      </CardHeader>
      <CardContent className="flex flex-col gap-4 text-sm">
        <form
          noValidate
          className="flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <div className="flex min-w-56 flex-1 flex-col gap-1">
            <label htmlFor="profile-name" className="text-xs font-medium">Name</label>
            <Input
              id="profile-name"
              autoComplete="name"
              maxLength={NAME_MAX}
              value={value}
              onChange={(e) => setValue(e.target.value)}
            />
          </div>
          <Button type="submit" size="sm" className="h-9" disabled={saving}>
            {saving && <Loader2 className="size-4 animate-spin" aria-hidden />} Save
          </Button>
        </form>
        <div className="flex flex-col gap-1">
          <p className="text-xs font-medium">Email</p>
          <p className="flex flex-wrap items-center gap-2">
            <span>{email}</span>
            <Badge variant={verified ? 'secondary' : 'outline'}>{verified ? 'Verified' : 'Not verified'}</Badge>
          </p>
        </div>
        {saved && <p role="status">Saved.</p>}
        {error && <p role="alert" className="text-destructive">{error}</p>}
      </CardContent>
    </Card>
  );
}
