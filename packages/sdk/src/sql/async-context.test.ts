import { describe, it, expect } from 'vitest';
import { hasAsyncContextFrame } from './async-context.js';

describe('hasAsyncContextFrame', () => {
  const at = (version: string, execArgv: string[] = [], nodeOptions?: string) => hasAsyncContextFrame({ version, execArgv, nodeOptions });

  it('is false before Node 24 (Node 20 and 22 run AsyncLocalStorage on promise hooks)', () => {
    expect(at('20.18.0')).toBe(false);
    expect(at('22.14.0')).toBe(false);
    expect(at('23.11.1')).toBe(false);
  });

  it('is true on Node 24 and later when the frame is not switched off', () => {
    expect(at('24.0.0')).toBe(true);
    expect(at('26.7.0', ['--enable-source-maps'], '--max-old-space-size=512')).toBe(true);
  });

  it('is false when --no-async-context-frame is on the command line or in NODE_OPTIONS', () => {
    expect(at('24.1.0', ['--no-async-context-frame'])).toBe(false);
    expect(at('26.7.0', [], '--max-old-space-size=512 --no-async-context-frame')).toBe(false);
    expect(at('26.7.0', [], '--no_async_context_frame')).toBe(false);
  });

  it('is false for a version it cannot read', () => {
    expect(at('')).toBe(false);
    expect(at('abc')).toBe(false);
    expect(hasAsyncContextFrame({ version: undefined as unknown as string, execArgv: undefined as unknown as string[] })).toBe(false);
  });

  it('reads the running process by default', () => {
    const major = Number(process.versions.node.split('.')[0]);
    const off = process.execArgv.includes('--no-async-context-frame') || (process.env.NODE_OPTIONS ?? '').includes('--no-async-context-frame');
    expect(hasAsyncContextFrame()).toBe(major >= 24 && !off);
  });
});
