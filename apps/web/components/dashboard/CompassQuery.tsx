'use client';
import { useState } from 'react';
import Link from 'next/link';
import type { EncryptedSample } from '@query-analyser/contract/runtime';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { CopyButton } from '@/components/dashboard/CopyButton';
import { RevealValues } from '@/components/dashboard/RevealValues';
import { compassCommand, defaultCollection, type SampleParts } from '@/src/compass';

const COPY_CLASS = 'rounded-full border px-3 py-1 text-xs text-muted-foreground hover:bg-muted';

const asParts = (v: unknown): SampleParts | null => (v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as SampleParts) : null);

/**
 * "Query for Compass": a ready-to-paste explain command built from the
 * redacted sample, with an editable collection name, plus — when the app has
 * a sample key — the in-browser "Reveal real values" flow.
 */
export function CompassQuery({
  model, redactedSample, appId, encryptedSample, sampleKeyEnabled, canManage, settingsHref,
}: {
  model: string;
  redactedSample: unknown;
  appId: string;
  encryptedSample: EncryptedSample | null;
  sampleKeyEnabled: boolean;
  canManage: boolean;
  settingsHref: string;
}) {
  const [collection, setCollection] = useState(() => defaultCollection(model));
  const parts = asParts(redactedSample);
  const command = parts ? compassCommand(collection, parts, { placeholder: true }) : null;

  return (
    <Card>
      <CardHeader><CardTitle className="text-base">Query for Compass <span className="ml-1 text-xs font-normal text-muted-foreground">Slowest sample</span></CardTitle></CardHeader>
      <CardContent className="flex flex-col gap-3 text-sm">
        <div className="flex max-w-xs items-center gap-2">
          <label htmlFor="compass-collection" className="text-xs text-muted-foreground">Collection</label>
          <Input
            id="compass-collection"
            className="h-8 font-mono text-xs"
            spellCheck={false}
            value={collection}
            onChange={(e) => setCollection(e.target.value)}
          />
        </div>

        {command && (
          <div className="flex items-start gap-2">
            <pre className="flex-1 overflow-x-auto rounded-xl border bg-muted p-3 font-mono text-xs"><code>{command}</code></pre>
            <CopyButton text={command} label="Copy the Compass command" className={COPY_CLASS} />
          </div>
        )}
        <p className="text-xs text-muted-foreground">
          Placeholders like <code className="font-mono text-accent-text">&lt;email&gt;</code> stand in for values — the SDK sends shapes only
          unless real-value samples are on.
        </p>

        {sampleKeyEnabled && encryptedSample && (
          <RevealValues appId={appId} encryptedSample={encryptedSample} collection={collection} />
        )}
        {sampleKeyEnabled && !encryptedSample && (
          <p className="text-xs text-muted-foreground">No encrypted sample for this query yet. One arrives with the next slowest run.</p>
        )}
        {!sampleKeyEnabled && canManage && (
          <Link href={settingsHref} className="text-xs font-medium text-accent-text hover:underline">Enable real values in Settings</Link>
        )}
      </CardContent>
    </Card>
  );
}
