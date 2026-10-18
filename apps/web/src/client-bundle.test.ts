// apps/web/src/client-bundle.test.ts
import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const STATIC = path.resolve(__dirname, '../.next/static');

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = path.join(dir, f);
    return statSync(p).isDirectory() ? files(p) : [p];
  });
}

describe.skipIf(!existsSync(STATIC))('client bundle (run after `next build`)', () => {
  it('never references the session cookie or the API bearer header', () => {
    const offenders = files(STATIC)
      .filter((f) => f.endsWith('.js'))
      .filter((f) => /qa_session|authorization['"]?\s*[:,]\s*[`'"]Bearer/i.test(readFileSync(f, 'utf8')));
    expect(offenders).toEqual([]);
  });
  it('never references the ingest-key create endpoint directly (only via /api/onboarding/app)', () => {
    const offenders = files(STATIC)
      .filter((f) => f.endsWith('.js'))
      .filter((f) => /\/v1\/apps\/[^"'`]*\/keys/.test(readFileSync(f, 'utf8')));
    expect(offenders).toEqual([]);
  });
});
