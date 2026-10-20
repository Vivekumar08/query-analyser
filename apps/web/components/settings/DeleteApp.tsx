'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, TriangleAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import {
  AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { orgPath } from '@/src/landing';

const GENERIC = 'Something went wrong. Please try again.';

function refreshSession(): void {
  window.location.assign(`/api/auth/refresh?next=${encodeURIComponent(window.location.pathname + window.location.search)}`);
}

/**
 * Settings → "Danger zone" (ADMIN+). Deleting the app needs its exact name
 * typed; the dialog stays open on an error so it can be read and retried.
 * On success the org home takes over (its empty state offers a new app).
 */
export function DeleteApp({ appId, appName, orgSlug }: { appId: string; appName: string; orgSlug: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const matches = typed === appName;

  const onOpenChange = (next: boolean) => {
    if (busy) return;
    setOpen(next);
    if (!next) {
      setTyped('');
      setError(null);
    }
  };

  const remove = async () => {
    if (!matches || busy) return;
    setError(null);
    setBusy(true);
    try {
      const res = await fetch(`/api/apps/${encodeURIComponent(appId)}`, {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
      });
      if (res.status === 401) return refreshSession();
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        setError(data.error ?? GENERIC);
        setBusy(false);
        return;
      }
      // Stays busy: the page is about to go.
      router.replace(orgPath(orgSlug));
      router.refresh();
    } catch {
      setError(GENERIC);
      setBusy(false);
    }
  };

  return (
    <Card className="border-destructive/40">
      <CardHeader>
        <h2 className="flex items-center gap-2 text-base font-semibold outline-none">
          <TriangleAlert className="size-4 text-destructive" aria-hidden /> Danger zone
        </h2>
      </CardHeader>
      <CardContent className="flex flex-wrap items-center justify-between gap-3 text-sm">
        <p className="text-muted-foreground">Delete this app with its keys, queries and samples.</p>
        <AlertDialog open={open} onOpenChange={onOpenChange}>
          <AlertDialogTrigger asChild>
            <Button variant="destructive" size="sm">Delete app</Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <form
              noValidate
              className="flex flex-col gap-4"
              onSubmit={(e) => {
                e.preventDefault();
                void remove();
              }}
            >
              <AlertDialogHeader>
                <AlertDialogTitle>{`Delete ${appName}?`}</AlertDialogTitle>
                <AlertDialogDescription>
                  This deletes its keys, queries and samples, and removes everyone&apos;s access to it. This can&apos;t be undone.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <div className="flex flex-col gap-1">
                <label htmlFor="delete-app-name" className="text-xs font-medium">{`Type ${appName} to confirm`}</label>
                <Input
                  id="delete-app-name"
                  autoComplete="off"
                  spellCheck={false}
                  value={typed}
                  disabled={busy}
                  onChange={(e) => setTyped(e.target.value)}
                />
              </div>
              {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
              <AlertDialogFooter>
                <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
                <Button type="submit" variant="destructive" disabled={!matches || busy}>
                  {busy && <Loader2 className="size-4 animate-spin" aria-hidden />} Delete app
                </Button>
              </AlertDialogFooter>
            </form>
          </AlertDialogContent>
        </AlertDialog>
      </CardContent>
    </Card>
  );
}
