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
  it('the main snippet says to call it before connecting', () =>
    expect(buildSnippet('k', 'a').code.split('\n')[0]).toBe('// Call this before your app connects to MongoDB.'));
  it('the driver snippet passes the client with monitorCommands and never inlines the key', () => {
    const s = buildSnippet('qa_live_abc', 'a"b');
    expect(s.driverCode).toContain('{ monitorCommands: true }');
    expect(s.driverCode).toContain('mongoClient: client');
    expect(s.driverCode).toContain('app: "a\\"b"');
    expect(s.driverCode).not.toContain('qa_live_abc');
  });
});
