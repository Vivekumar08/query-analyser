'use client';
import { useState } from 'react';
import { KeyRound, Loader2 } from 'lucide-react';
import { generateSampleKeyPair, wrapPrivateKey } from '@query-analyser/contract/runtime';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { CopyButton } from '@/components/dashboard/CopyButton';
import { passphraseIssue, passphraseStrength } from '@/src/passphrase';

type Status = { enabled: boolean; publicKey?: string };
type Mode = 'idle' | 'confirm-rotate' | 'confirm-disable' | 'setup';

const GENERIC = 'Something went wrong. Please try again.';
const COPY_CLASS = 'rounded-full border px-3 py-1 text-xs text-muted-foreground hover:bg-muted';
const STRENGTH_LABEL = { weak: 'Weak', fair: 'Fair', strong: 'Strong' } as const;

function refreshSession(): void {
  window.location.assign(`/api/auth/refresh?next=${encodeURIComponent(window.location.pathname + window.location.search)}`);
}

/**
 * Settings → "Real-value samples". Key generation and wrapping happen here, in
 * the browser: the passphrase and the private key live only in this
 * component's memory and the Web Crypto calls. The only request body is the
 * public key and the passphrase-wrapped private key.
 *
 * `initial` deliberately omits the wrapped key: this page never needs it.
 */
export function SampleKeySection({ appId, canManage, initial }: { appId: string; canManage: boolean; initial: Status }) {
  const [status, setStatus] = useState<Status>(initial);
  const [mode, setMode] = useState<Mode>('idle');
  const [passphrase, setPassphrase] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const endpoint = `/api/apps/${encodeURIComponent(appId)}/sample-key`;
  const rotating = status.enabled;

  const resetForm = () => {
    setPassphrase('');
    setConfirm('');
  };
  const closeSetup = () => {
    resetForm();
    setError(null);
    setMode('idle');
  };

  const saveKey = async () => {
    const issue = passphraseIssue(passphrase, confirm);
    if (issue) {
      setError(issue);
      return;
    }
    setError(null);
    setPending(true);
    try {
      let body: string;
      try {
        const pair = await generateSampleKeyPair();
        const wrapped = await wrapPrivateKey(pair.privateKey, passphrase);
        body = JSON.stringify({ publicKey: pair.publicKey, wrapped });
      } catch {
        setError("This browser couldn't generate a key. Try a current Chrome, Firefox or Safari over HTTPS.");
        return;
      } finally {
        // The passphrase is not needed past the wrap; drop it from memory.
        resetForm();
      }
      const res = await fetch(endpoint, { method: 'PUT', headers: { 'content-type': 'application/json' }, body });
      if (res.status === 401) return refreshSession();
      const data = (await res.json().catch(() => ({}))) as { error?: string; publicKey?: string };
      if (!res.ok || !data.publicKey) {
        setError(data.error ?? GENERIC);
        return;
      }
      setStatus({ enabled: true, publicKey: data.publicKey });
      setMode('idle');
    } catch {
      setError(GENERIC);
    } finally {
      setPending(false);
    }
  };

  const disable = async () => {
    setError(null);
    setPending(true);
    try {
      const res = await fetch(endpoint, { method: 'DELETE', headers: { 'content-type': 'application/json' } });
      if (res.status === 401) return refreshSession();
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        setError(data.error ?? GENERIC);
        return;
      }
      setStatus({ enabled: false });
    } catch {
      setError(GENERIC);
    } finally {
      setPending(false);
      setMode('idle');
    }
  };

  const envLine = status.enabled && status.publicKey ? `QA_SAMPLE_KEY=${status.publicKey}` : null;
  const strength = passphrase ? passphraseStrength(passphrase) : null;

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-2">
        <CardTitle className="flex items-center gap-2 text-base"><KeyRound className="size-4" aria-hidden /> Real-value samples</CardTitle>
        <Badge variant="secondary">{status.enabled ? 'On' : 'Off'}</Badge>
      </CardHeader>
      <CardContent className="flex flex-col gap-4 text-sm">
        <p className="text-muted-foreground">
          Your app encrypts the real values of each query&apos;s slowest sample with a public key. Only someone with the
          passphrase can read them, in their own browser — this service never can.
        </p>

        {!canManage && (
          <p>
            {status.enabled
              ? 'Real-value samples are enabled for this app.'
              : 'Real-value samples are not enabled for this app. Ask an admin to turn them on.'}
          </p>
        )}

        {canManage && envLine && mode !== 'setup' && (
          <div className="flex flex-col gap-2">
            <p className="text-muted-foreground">
              Add this to your app&apos;s environment and pass <code className="font-mono text-accent-text">sampleKey: process.env.QA_SAMPLE_KEY</code> to <code className="font-mono">init()</code>:
            </p>
            <div className="flex items-start gap-2">
              <pre className="flex-1 overflow-x-auto rounded-xl border bg-muted p-3 font-mono text-xs"><code>{envLine}</code></pre>
              <CopyButton text={envLine} label="Copy the sample key env line" className={COPY_CLASS} />
            </div>
          </div>
        )}

        {canManage && mode !== 'setup' && (
          <div className="flex flex-wrap gap-2">
            {status.enabled ? (
              <>
                <Button size="sm" variant="outline" disabled={pending} onClick={() => setMode('confirm-rotate')}>Rotate</Button>
                <Button size="sm" variant="ghost" disabled={pending} onClick={() => setMode('confirm-disable')}>
                  {pending && <Loader2 className="size-4 animate-spin" />} Disable
                </Button>
              </>
            ) : (
              <Button size="sm" onClick={() => { setError(null); setMode('setup'); }}>Enable</Button>
            )}
          </div>
        )}

        {canManage && mode === 'setup' && (
          // No `name` on the inputs: even a pre-hydration native submit can't serialise the passphrase.
          <form
            className="flex max-w-md flex-col gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              void saveKey();
            }}
          >
            <p className="font-medium">{rotating ? 'Choose a passphrase for the new key' : 'Choose a passphrase'}</p>
            <p className="rounded-xl border border-destructive/30 bg-destructive/5 p-3 text-xs">
              If you lose this passphrase, stored values cannot be recovered. Share it with your team out of band — it is
              never sent to this service.
            </p>
            <label htmlFor="sample-passphrase" className="font-medium">Passphrase</label>
            <Input
              id="sample-passphrase"
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={passphrase}
              onChange={(e) => setPassphrase(e.target.value)}
            />
            {strength && <p className="text-xs text-muted-foreground">Strength: <span className="text-accent-text">{STRENGTH_LABEL[strength]}</span> · at least 12 characters</p>}
            <label htmlFor="sample-passphrase-confirm" className="font-medium">Confirm passphrase</label>
            <Input
              id="sample-passphrase-confirm"
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
            />
            {error && <p role="alert" className="text-destructive">{error}</p>}
            <div className="flex gap-2">
              <Button type="submit" size="sm" disabled={pending}>
                {pending && <Loader2 className="size-4 animate-spin" />} Generate key
              </Button>
              <Button type="button" size="sm" variant="ghost" disabled={pending} onClick={closeSetup}>Cancel</Button>
            </div>
            {pending && <p className="text-xs text-muted-foreground">Generating and wrapping the key in your browser…</p>}
          </form>
        )}

        {mode !== 'setup' && error && <p role="alert" className="text-destructive">{error}</p>}
      </CardContent>

      <AlertDialog open={mode === 'confirm-rotate' || mode === 'confirm-disable'} onOpenChange={(o) => {
          // "Rotate key" moves on to setup before the dialog reports closing; keep that.
          if (!o) setMode((m) => (m === 'setup' ? m : 'idle'));
        }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{mode === 'confirm-rotate' ? 'Rotate the sample key?' : 'Disable real-value samples?'}</AlertDialogTitle>
            <AlertDialogDescription>
              {mode === 'confirm-rotate'
                ? "Rotating clears every stored encrypted sample for this app — they can't be read with the new key. You'll choose a passphrase next, then update QA_SAMPLE_KEY in your app."
                : 'Disabling removes the key and clears every stored encrypted sample for this app. Your app keeps sending shapes only.'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            {mode === 'confirm-rotate' ? (
              <AlertDialogAction onClick={() => { setError(null); setMode('setup'); }}>Rotate key</AlertDialogAction>
            ) : (
              <AlertDialogAction onClick={() => void disable()}>Disable encrypted samples</AlertDialogAction>
            )}
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
