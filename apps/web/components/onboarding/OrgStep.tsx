'use client';
import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

export function OrgStep({ onCreated }: { onCreated: (slug: string) => void }) {
  const [name, setName] = useState('');
  const [pending, setPending] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (pending) return;
    setPending(true);
    try {
      const res = await fetch('/api/onboarding/org', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string; slug?: string };
      if (res.status === 201) {
        onCreated((body as { slug: string }).slug);
        return;
      }
      toast.error(body.error ?? 'Something went wrong. Please try again.');
    } catch {
      toast.error('Something went wrong. Please try again.');
    }
    setPending(false);
  };

  return (
    <Card>
      <CardHeader><CardTitle>Name your workspace</CardTitle></CardHeader>
      <CardContent>
        <form onSubmit={submit} className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <Label htmlFor="OrgStep-name">Workspace name</Label>
            <Input id="OrgStep-name" autoFocus required minLength={2} maxLength={60} placeholder="Acme" value={name} onChange={(e) => setName(e.target.value)} />
            <p className="text-xs text-muted-foreground">Usually your company or team name.</p>
          </div>
          <Button type="submit" className="self-start" disabled={pending || name.trim().length < 2}>
            {pending && <Loader2 className="size-4 animate-spin" aria-hidden />} Continue
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
