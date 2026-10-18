'use client';
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { motion, useReducedMotion } from 'framer-motion';
import { AlertTriangle, CheckCircle2, Copy } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { navigateToRefresh } from './session-expiry';
import { buildSnippet } from './snippet';

const POLL_MS = 5000;
const HELP_AFTER_MS = 180_000;

export function InstallStep({
  appId, appName, ingestKey, keyError = null, doneHref,
}: { appId: string; appName: string; ingestKey: string | null; keyError?: 'forbidden' | 'failed' | null; doneHref: string }) {
  const router = useRouter();
  const reduce = useReducedMotion();
  // The key lives only here (and in OnboardingFlow's state): a new one from
  // "Create a new key" replaces the prop's value.
  const [key, setKey] = useState<string | null>(ingestKey);
  const [creating, setCreating] = useState(false);
  const [expired, setExpired] = useState(false);
  const [copied, setCopied] = useState(false);
  const [confirmLeave, setConfirmLeave] = useState(false);
  const [connected, setConnected] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const started = useRef(Date.now());

  // A 401 with an uncopied key must not navigate away: keep the key on screen
  // and let the user continue once they have copied it.
  const handleExpired = () => {
    if (keyRef.current && !copiedRef.current) setExpired(true);
    else navigateToRefresh();
  };
  const keyRef = useRef(key);
  const copiedRef = useRef(copied);
  keyRef.current = key;
  copiedRef.current = copied;

  useEffect(() => {
    if (connected || expired) return;
    let stopped = false;
    const tick = async () => {
      if (document.visibilityState !== 'visible') return;
      try {
        const res = await fetch(`/api/apps/${encodeURIComponent(appId)}/status`, { cache: 'no-store' });
        if (res.status === 401) {
          stopped = true;
          handleExpired();
          return;
        }
        if (!res.ok) throw new Error(String(res.status));
        const body = (await res.json()) as { lastSeenAt: string | null };
        setReconnecting(false);
        if (body.lastSeenAt && !stopped) setConnected(true);
      } catch {
        setReconnecting(true);
      }
      if (Date.now() - started.current > HELP_AFTER_MS) setShowHelp(true);
    };
    void tick();
    const id = setInterval(tick, POLL_MS);
    return () => { stopped = true; clearInterval(id); };
  }, [appId, connected, expired]);

  // Closing the tab before copying would lose the key for good.
  useEffect(() => {
    if (!key || copied) return;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [key, copied]);

  const createKey = async () => {
    setCreating(true);
    try {
      const res = await fetch(`/api/apps/${encodeURIComponent(appId)}/keys`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      const body = (await res.json().catch(() => ({}))) as { key?: string; error?: string };
      if (res.status === 401) { navigateToRefresh(); return; }
      if (res.status === 201 && body.key) {
        setKey(body.key);
        return;
      }
      toast.error(body.error ?? 'Something went wrong. Please try again.');
    } catch {
      toast.error('Something went wrong. Please try again.');
    } finally {
      setCreating(false);
    }
  };

  if (!key) {
    const forbidden = keyError === 'forbidden';
    return (
      <Card>
        <CardHeader><CardTitle>{keyError === 'failed' ? "Couldn't create a key" : forbidden ? 'No key created' : 'Key already shown'}</CardTitle></CardHeader>
        <CardContent className="flex flex-col gap-3 text-sm text-muted-foreground">
          {forbidden ? (
            <p>Only workspace admins can create keys — ask an admin.</p>
          ) : (
            <p>
              {keyError === 'failed'
                ? 'Your app was created, but we could not create its ingest key.'
                : 'For your security an ingest key is only shown once.'}{' '}
              Create a new key to install the agent.
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            {!forbidden && (
              <Button onClick={createKey} disabled={creating}>Create a new key</Button>
            )}
            <Button asChild variant="outline"><Link href={doneHref}>Go to your queries</Link></Button>
          </div>
        </CardContent>
      </Card>
    );
  }

  const s = buildSnippet(key, appName);
  const copy = async (text: string, what: string) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      toast.error('Could not copy — select the text and copy it manually.');
      return;
    }
    setCopied(true);
    toast.success(`${what} copied`);
  };
  const leave = () => (copied ? router.push(doneHref) : setConfirmLeave(true));

  return (
    <div className="flex flex-col gap-5">
      <h2 className="text-xl font-semibold tracking-tight">Install the agent</h2>
      {expired && (
        <div role="alert" className="flex flex-wrap items-center gap-3 rounded-lg border p-3 text-sm">
          <p className="flex-1">Your session expired — copy your key, then continue.</p>
          <Button onClick={navigateToRefresh}>Continue</Button>
        </div>
      )}
      <div role="note" className="flex gap-2 rounded-lg border border-amber-200 bg-warning-bg p-3 text-sm text-warning-fg">
        <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
        <p><strong>This key is shown once.</strong> Copy it now — we can&apos;t show it again.</p>
      </div>
      <pre className="overflow-x-auto rounded-xl border bg-white/70 p-4 font-mono text-sm"><code>{s.install}{'\n\n'}{s.code}</code></pre>
      <p className="text-xs text-muted-foreground">Prefer an environment variable in production: <code className="font-mono">apiKey: process.env.QA_KEY</code>.</p>
      <div className="flex flex-wrap gap-2">
        <Button onClick={() => copy(`${s.install}\n\n${s.code}`, 'Snippet')}><Copy className="size-4" /> Copy snippet</Button>
        <Button variant="outline" onClick={() => copy(key, 'Key')}><Copy className="size-4" /> Copy key</Button>
      </div>

      <Card aria-live="polite">
        <CardContent className="flex items-center gap-3 py-4">
          {connected ? (
            <motion.div initial={reduce ? false : { scale: 0.9, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} className="flex flex-1 items-center gap-3">
              <CheckCircle2 className="size-5 text-emerald-600" aria-hidden />
              <span className="font-medium">Connected — your first batch arrived.</span>
            </motion.div>
          ) : (
            <div className="flex flex-1 items-center gap-3 text-sm text-muted-foreground">
              <span className="relative flex size-2.5">
                {!reduce && <span className="absolute inline-flex size-full animate-ping rounded-full bg-chart-1/60" />}
                <span className="relative inline-flex size-2.5 rounded-full bg-chart-1" />
              </span>
              {reconnecting ? 'Reconnecting…' : 'Waiting for your first batch…'}
            </div>
          )}
          <Button variant={connected ? 'default' : 'ghost'} onClick={leave}>
            {connected ? 'Go to your queries →' : 'Skip for now'}
          </Button>
        </CardContent>
      </Card>

      {showHelp && !connected && (
        <Card>
          <CardHeader><CardTitle className="text-base">Not seeing data?</CardTitle></CardHeader>
          <CardContent>
            <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
              <li>The key is set in the running process (<code className="font-mono">QA_KEY</code> or inline).</li>
              <li>Your app uses mongoose 8.</li>
              <li>Only queries taking 100&nbsp;ms or more are reported — trigger a slow one.</li>
              <li>Batches ship every 10 seconds.</li>
            </ul>
          </CardContent>
        </Card>
      )}

      <AlertDialog open={confirmLeave} onOpenChange={setConfirmLeave}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>You haven&apos;t copied your key</AlertDialogTitle>
            <AlertDialogDescription>It won&apos;t be shown again. Leave anyway?</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Stay</AlertDialogCancel>
            <AlertDialogAction onClick={() => router.push(doneHref)}>Leave</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
