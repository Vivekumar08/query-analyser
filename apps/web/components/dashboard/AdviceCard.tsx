'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Copy, Lightbulb, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import type { Advice } from '@/src/dashboard-types';
import { createIndexCall } from '@/src/detail-view';

type Target = 'APPLIED' | 'DISMISSED';

export function AdviceCard({ appId, model, advice }: { appId: string; model: string; advice: Advice | null }) {
  const router = useRouter();
  const [confirm, setConfirm] = useState<Target | null>(null);
  const [pending, setPending] = useState(false);
  const [status, setStatus] = useState(advice?.status ?? 'OPEN');

  if (!advice) {
    return (
      <Card>
        <CardHeader><CardTitle className="flex items-center gap-2 text-base"><Lightbulb className="size-4" /> Suggested index</CardTitle></CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          No index suggestion — this query already looks indexed or is too rare to judge.
        </CardContent>
      </Card>
    );
  }

  const call = createIndexCall(model, advice.suggestion);
  const submit = async (target: Target) => {
    setPending(true);
    try {
      const res = await fetch(`/api/apps/${encodeURIComponent(appId)}/advice/${encodeURIComponent(advice.id)}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status: target }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (res.status === 401) {
        window.location.assign(`/api/auth/refresh?next=${encodeURIComponent(window.location.pathname + window.location.search)}`);
        return;
      }
      if (!res.ok) throw new Error(body.error ?? 'Something went wrong. Please try again.');
      setStatus(target);
      toast.success(target === 'APPLIED' ? 'Marked as applied' : 'Suggestion dismissed');
      router.refresh();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setPending(false);
      setConfirm(null);
    }
  };

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-2">
        <CardTitle className="flex items-center gap-2 text-base"><Lightbulb className="size-4" /> Suggested index</CardTitle>
        {status !== 'OPEN' && <Badge variant="secondary">{status === 'APPLIED' ? 'Applied' : 'Dismissed'}</Badge>}
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="flex items-start gap-2">
          <pre className="flex-1 overflow-x-auto rounded-md border bg-muted p-3 font-mono text-sm"><code>{call}</code></pre>
          <Button variant="outline" size="icon" aria-label="Copy createIndex call"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(call);
                toast.success('Copied');
              } catch {
                toast.error('Could not copy — select the text instead.');
              }
            }}>
            <Copy className="size-4" />
          </Button>
        </div>
        <p className="text-sm text-muted-foreground">{advice.rationale}</p>
        {status === 'OPEN' && (
          <div className="flex gap-2">
            <Button size="sm" disabled={pending} onClick={() => setConfirm('APPLIED')}>
              {pending && <Loader2 className="size-4 animate-spin" />} Mark as applied
            </Button>
            <Button size="sm" variant="ghost" disabled={pending} onClick={() => setConfirm('DISMISSED')}>Dismiss</Button>
          </div>
        )}
      </CardContent>
      <AlertDialog open={confirm !== null} onOpenChange={(o) => !o && setConfirm(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{confirm === 'APPLIED' ? 'Mark this index as applied?' : 'Dismiss this suggestion?'}</AlertDialogTitle>
            <AlertDialogDescription>This can&apos;t be undone.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => confirm && submit(confirm)}>Confirm</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
