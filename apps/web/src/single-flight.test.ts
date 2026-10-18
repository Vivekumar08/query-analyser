import { describe, it, expect, vi } from 'vitest';
import { singleFlight } from './single-flight';

const deferred = <T>() => {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};

describe('singleFlight', () => {
  it('runs the work once for concurrent callers on the same key', async () => {
    // This is the whole point. Two concurrent server renders both hitting a
    // 401 would both call /v1/auth/refresh; the API's family-revocation
    // treats the second as a replay and logs the user out entirely.
    const run = singleFlight<string>();
    const d = deferred<string>();
    const fn = vi.fn(() => d.promise);

    const a = run('k', fn);
    const b = run('k', fn);
    d.resolve('token');

    expect(await a).toBe('token');
    expect(await b).toBe('token');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('keeps different keys independent', async () => {
    const run = singleFlight<string>();
    const fn = vi.fn(async (v: string) => v);
    const [x, y] = await Promise.all([run('a', () => fn('a')), run('b', () => fn('b'))]);
    expect([x, y]).toEqual(['a', 'b']);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('releases the key after success, so a later call does fresh work', async () => {
    // Without release, one refresh would be cached forever and the session
    // would die the moment that token expired.
    const run = singleFlight<number>();
    const fn = vi.fn(async () => 1);
    await run('k', fn);
    await run('k', fn);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('releases the key after failure, so a transient error is retryable', async () => {
    // A rejected promise left in the map would make every subsequent refresh
    // fail with the same stale error, permanently.
    const run = singleFlight<number>();
    const bad = vi.fn(async () => { throw new Error('nope'); });
    await expect(run('k', bad)).rejects.toThrow('nope');
    const good = vi.fn(async () => 7);
    expect(await run('k', good)).toBe(7);
  });

  it('propagates the rejection to every concurrent caller', async () => {
    const run = singleFlight<number>();
    const d = deferred<number>();
    const fn = () => d.promise;
    const a = run('k', fn);
    const b = run('k', fn);
    d.reject(new Error('boom'));
    await expect(a).rejects.toThrow('boom');
    await expect(b).rejects.toThrow('boom');
  });
});
