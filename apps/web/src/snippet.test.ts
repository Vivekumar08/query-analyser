// apps/web/src/snippet.test.ts
import { describe, it, expect } from 'vitest';
import { buildSnippet } from '@/components/onboarding/snippet';

describe('buildSnippet', () => {
  it('inlines key and app name', () => {
    const s = buildSnippet('qa_live_abc', 'my-service');
    expect(s.install).toBe('npm install @vivekumar08/query-analyser');
    expect(s.code).toContain(`apiKey: "qa_live_abc"`);
    expect(s.code).toContain(`app: "my-service"`);
    expect(s.code).toContain(`require('@vivekumar08/query-analyser').init({`);
  });
  it('escapes quotes in the app name', () =>
    expect(buildSnippet('k', 'a"b').code).toContain('app: "a\\"b"'));
});
