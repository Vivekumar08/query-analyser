'use client';
import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { navigateToRefresh } from './session-expiry';
import { Label } from '@/components/ui/label';

export function AppStep({ org, onCreated }: { org: string; onCreated: (app: { id: string; name: string }, key: string | null, keyError: 'forbidden' | 'failed' | null) => void }) {
  const [name, setName] = useState('');
  const [pending, setPending] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (pending) return;
    setPending(true);
    try {
      const res = await fetch('/api/onboarding/app', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ org, name }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string; app?: { id: string; name: string }; key?: string | null; keyError?: 'forbidden' | 'failed' };
      if (res.status === 201) {
        onCreated(body.app!, body.key ?? null, body.keyError ?? null);
        return;
      }
      if (res.status === 401) { navigateToRefresh(); return; }
      toast.error(body.error ?? 'Something went wrong. Please try again.');
    } catch {
      toast.error('Something went wrong. Please try again.');
    }
    setPending(false);
  };

  return (
    <Card>
      <CardHeader><CardTitle>Create your first app</CardTitle></CardHeader>
      <CardContent>
        <form onSubmit={submit} className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <Label htmlFor="AppStep-name">App name</Label>
            <Input id="AppStep-name" autoFocus required minLength={1} maxLength={60} placeholder="my-service" value={name} onChange={(e) => setName(e.target.value)} />
            <p className="text-xs text-muted-foreground">The name your service reports as. You can add more apps later.</p>
          </div>
          <Button type="submit" className="self-start" disabled={pending || name.trim().length < 1}>
            {pending && <Loader2 className="size-4 animate-spin" aria-hidden />} Continue
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
