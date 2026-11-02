import { describe, it, expect } from 'vitest';
import { withAppLock, lockCount } from './lock.js';

const tick = () => new Promise((r) => setTimeout(r, 5));

describe('withAppLock', () => {
  it('serialises calls for the same app but not across apps', async () => {
    const log: string[] = [];
    const job = (name: string) => async () => { log.push(`${name}:start`); await tick(); log.push(`${name}:end`); };
    await Promise.all([withAppLock('a', job('1')), withAppLock('a', job('2')), withAppLock('b', job('3'))]);
    expect(log.indexOf('1:end')).toBeLessThan(log.indexOf('2:start'));
    expect(log.indexOf('3:start')).toBeLessThan(log.indexOf('1:end'));
  });

  it('releases on throw and returns the value otherwise', async () => {
    await expect(withAppLock('a', async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(await withAppLock('a', async () => 42)).toBe(42);
  });

  it('cleans up its map entry', async () => {
    await Promise.all([withAppLock('a', tick), withAppLock('a', tick)]);
    expect(lockCount()).toBe(0);
  });
});
