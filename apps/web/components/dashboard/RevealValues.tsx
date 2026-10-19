'use client';
import { useRef, useState } from 'react';
import { Eye, EyeOff, Loader2 } from 'lucide-react';
import {
  SampleKeyError, decryptSample, unwrapPrivateKey,
  type EncryptedSample, type WrappedKey,
} from '@query-analyser/contract/runtime';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { CopyButton } from '@/components/dashboard/CopyButton';
import { compassCommand, parseRealSample, type SampleParts } from '@/src/compass';

const COPY_CLASS = 'rounded-full border px-3 py-1 text-xs text-muted-foreground hover:bg-muted';
const GENERIC = 'Something went wrong. Please try again.';

const MESSAGES = {
  'wrong-passphrase': "That passphrase didn't unlock the key.",
  undecryptable: 'This sample was encrypted with a different key (it may predate a rotation).',
  'invalid-public-key': GENERIC,
} as const;

class RevealError extends Error {}

type Revealed = { sample: SampleParts; pretty: string };

function refreshSession(): void {
  window.location.assign(`/api/auth/refresh?next=${encodeURIComponent(window.location.pathname + window.location.search)}`);
}

/**
 * "Reveal real values". Everything secret stays in this component: the
 * passphrase (cleared as soon as an attempt starts), the unwrapped private
 * key (a local, non-extractable CryptoKey dropped after one decrypt) and the
 * plaintext (React state, removed by Hide or unmount). The only request is a
 * body-less GET of the passphrase-wrapped key; nothing is logged or stored.
 */
export function RevealValues({ appId, encryptedSample, collection }: { appId: string; encryptedSample: EncryptedSample; collection: string }) {
  const [open, setOpen] = useState(false);
  const [passphrase, setPassphrase] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [revealed, setRevealed] = useState<Revealed | null>(null);
  // Bumped by Hide/close so a slow unlock can't reveal after the user moved on.
  const attempt = useRef(0);

  const unlock = async () => {
    const secret = passphrase;
    setPassphrase('');
    setError(null);
    setPending(true);
    const mine = ++attempt.current;
    try {
      const res = await fetch(`/api/apps/${encodeURIComponent(appId)}/sample-key`, { cache: 'no-store' });
      if (res.status === 401) return refreshSession();
      const data = (await res.json().catch(() => ({}))) as { enabled?: boolean; wrapped?: WrappedKey; error?: string };
      if (!res.ok) throw new RevealError(data.error ?? GENERIC);
      if (!data.enabled || !data.wrapped) throw new RevealError('Real values are no longer enabled for this app.');
      const key = await unwrapPrivateKey(data.wrapped, secret);
      const text = await decryptSample(key, encryptedSample);
      const sample = parseRealSample(text);
      if (!sample) throw new RevealError("This sample couldn't be read.");
      if (mine !== attempt.current) return;
      setRevealed({ sample, pretty: JSON.stringify(sample, null, 2) });
      setOpen(false);
    } catch (err) {
      if (mine !== attempt.current) return;
      if (err instanceof SampleKeyError) setError(MESSAGES[err.code]);
      else if (err instanceof RevealError) setError(err.message);
      else setError(GENERIC);
    } finally {
      if (mine === attempt.current) setPending(false);
    }
  };

  const hide = () => {
    attempt.current++;
    setRevealed(null);
    setPending(false);
  };

  const onOpenChange = (next: boolean) => {
    if (!next) {
      attempt.current++;
      setPassphrase('');
      setPending(false);
    }
    setError(null);
    setOpen(next);
  };

  const command = revealed ? compassCommand(collection, revealed.sample, { placeholder: false }) : null;

  return (
    <div className="flex flex-col gap-3">
      {revealed && command ? (
        <div className="flex flex-col gap-3 rounded-xl border border-accent-text/20 p-3">
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs font-medium uppercase tracking-wide text-accent-text">Real values · only in this browser</p>
            <Button size="sm" variant="ghost" onClick={hide}><EyeOff className="size-4" aria-hidden /> Hide</Button>
          </div>
          <div className="flex items-start gap-2">
            <pre className="flex-1 overflow-x-auto rounded-xl border bg-muted p-3 font-mono text-xs"><code>{command}</code></pre>
            <CopyButton text={command} label="Copy the real Compass command" className={COPY_CLASS} />
          </div>
          <div className="flex items-start gap-2">
            <pre className="flex-1 overflow-x-auto rounded-xl border bg-muted p-3 font-mono text-xs"><code>{revealed.pretty}</code></pre>
            <CopyButton text={revealed.pretty} label="Copy the real query" className={COPY_CLASS} />
          </div>
        </div>
      ) : (
        <div>
          <Button size="sm" variant="outline" onClick={() => onOpenChange(true)}><Eye className="size-4" aria-hidden /> Reveal real values</Button>
        </div>
      )}

      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reveal real values</DialogTitle>
            <DialogDescription>
              Enter the team passphrase. The key is unlocked and the sample decrypted in this browser; the passphrase and
              the values are never sent anywhere.
            </DialogDescription>
          </DialogHeader>
          {/* No `name` on the input: even a pre-hydration native submit can't serialise the passphrase. */}
          <form
            className="flex flex-col gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              void unlock();
            }}
          >
            <label htmlFor="reveal-passphrase" className="text-sm font-medium">Passphrase</label>
            <Input
              id="reveal-passphrase"
              type="password"
              autoComplete="off"
              spellCheck={false}
              autoFocus
              value={passphrase}
              onChange={(e) => setPassphrase(e.target.value)}
            />
            {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
            {pending && <p className="text-xs text-muted-foreground">Unlocking in your browser…</p>}
            <DialogFooter>
              <Button type="button" size="sm" variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
              <Button type="submit" size="sm" disabled={pending || passphrase.length === 0}>
                {pending && <Loader2 className="size-4 animate-spin" />} Unlock
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
