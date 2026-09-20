import { describe, it, expect, vi, afterEach } from 'vitest';
import mongoose from 'mongoose';
import { init, shutdown } from './index.js';
import { buildSignature, type SignatureResult } from './signature.js';

afterEach(async () => { await shutdown(); });

const okFetch = () => Promise.resolve(new Response('{}', { status: 202 }));

/**
 * `_aggregator` is a test-only seam on the internal analyser (not part of
 * the public Analyser type) that lets these unit tests put content into the
 * aggregator directly, since there is no live mongoose connection here to
 * produce it via real queries.
 */
type Seedable = { _aggregator: { add(sig: SignatureResult, ms: number, sample: unknown): void; size: number } };

function seed(a: ReturnType<typeof init>, key = 'x'): SignatureResult {
  const sig = buildSignature({ model: 'M', operation: 'find', filter: { [key]: 1 } });
  (a as unknown as Seedable)._aggregator.add(sig, 120, null);
  return sig;
}

describe('init', () => {
  it('requires an apiKey and an app name', () => {
    expect(() => init({ apiKey: '', app: 'x' })).toThrow(/apiKey/);
    expect(() => init({ apiKey: 'k', app: '' })).toThrow(/app/);
  });

  it('instruments models compiled BEFORE init was called', () => {
    const m = mongoose;
    m.model(`BeforeInit_${Date.now()}`, new mongoose.Schema({ a: String }));
    const a = init({ apiKey: 'k', app: 'x', mongoose: m, fetchImpl: okFetch });
    expect(a.installedModels).toBeGreaterThan(0);
  });

  it('instruments models compiled AFTER init via the global plugin', () => {
    const m = mongoose;
    init({ apiKey: 'k', app: 'x', mongoose: m, fetchImpl: okFetch });
    const schema = new mongoose.Schema({ a: String });
    m.model(`AfterInit_${Date.now()}`, schema);
    // The global plugin ran, so the install marker is on the schema.
    expect(Object.getOwnPropertySymbols(schema).some((s) => String(s).includes('query-analyser')))
      .toBe(true);
  });

  it('does nothing at all when disabled', () => {
    const fetchImpl = vi.fn(okFetch);
    const a = init({ apiKey: 'k', app: 'x', enabled: false, mongoose, fetchImpl });
    expect(a.installedModels).toBe(0);
  });

  it('sends nothing when the window is empty', async () => {
    const fetchImpl = vi.fn(okFetch);
    const a = init({ apiKey: 'k', app: 'x', mongoose, fetchImpl });
    await a.flush();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  // Controller Ruling B: the brief's "stops sending after the server rejects
  // the key" test flushes an empty buffer, so flush() returns before calling
  // fetch and the assertion passes vacuously. Dropped here; the disable latch
  // is asserted in Task 9's integration test where real queries produce real
  // content.

  // Fix round 1, Critical: process.once('SIGTERM', ...) with a handler that
  // never calls process.exit() removes Node's default terminate-on-SIGTERM
  // behavior — a host app with an open HTTP server or DB pool would no
  // longer exit on SIGTERM at all. init() must not touch that listener.
  it('does not add a SIGTERM listener', () => {
    const before = process.listenerCount('SIGTERM');
    init({ apiKey: 'k', app: 'x', mongoose, fetchImpl: okFetch });
    expect(process.listenerCount('SIGTERM')).toBe(before);
  });

  // Fix round 1, Important 1: setInterval doesn't await flush(), so a
  // send() slower than flushIntervalMs could otherwise let two flushes
  // overlap, each swap()ing the buffer concurrently.
  it('never runs two flushes concurrently', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const fetchImpl = vi.fn(async () => {
      await gate;
      return new Response('{}', { status: 202 });
    });
    const a = init({ apiKey: 'k', app: 'x', mongoose, fetchImpl });
    seed(a);

    const p1 = a.flush();
    const p2 = a.flush();
    // Both calls have started, but the second must have bailed out via the
    // in-flight guard before ever reaching the network.
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    release();
    await Promise.all([p1, p2]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  // Fix round 1, missing test: retry -> merge, then a later flush resends.
  it('re-merges an undelivered batch on retry and resends it later', async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async (_url: Parameters<typeof fetch>[0], _init?: Parameters<typeof fetch>[1]) => {
      calls++;
      if (calls === 1) return new Response('unavailable', { status: 503 });
      return new Response('{}', { status: 202 });
    });
    const a = init({ apiKey: 'k', app: 'x', mongoose, fetchImpl });
    const sig = seed(a);

    await a.flush();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    // The 503 batch was merged back into the buffer, not dropped.
    expect((a as unknown as Seedable)._aggregator.size).toBe(1);

    // shutdown() resets the backoff and drains, forcing a second send.
    await a.shutdown();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const secondCall = fetchImpl.mock.calls[1]!;
    const secondInit = secondCall[1] as RequestInit;
    expect(String(secondInit.body)).toContain(sig.hash);
  });

  // Fix round 1, missing test: shutdown() drains whatever is buffered.
  it('drains the buffer on shutdown', async () => {
    const fetchImpl = vi.fn(async (_url: Parameters<typeof fetch>[0], _init?: Parameters<typeof fetch>[1]) => okFetch());
    const a = init({ apiKey: 'k', app: 'x', mongoose, fetchImpl });
    const sig = seed(a, 'y');

    await a.shutdown();

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const call = fetchImpl.mock.calls[0]!;
    const reqInit = call[1] as RequestInit;
    expect(String(reqInit.body)).toContain(sig.hash);
  });

  // Fix round 1, Minor: a second init() with a different apiKey/app reuses
  // the live instance instead of silently swallowing the new identity.
  it('warns and reuses the existing instance when init() is called again with different options', () => {
    const onError = vi.fn();
    const a1 = init({ apiKey: 'k1', app: 'app1', mongoose, fetchImpl: okFetch, onError });
    const a2 = init({ apiKey: 'k2', app: 'app2', mongoose, fetchImpl: okFetch, onError });

    expect(a2).toBe(a1);
    expect(onError).toHaveBeenCalledTimes(1);
    expect((onError.mock.calls[0]![0] as Error).message).toMatch(/already called with different options/);
  });

  // Fix round 1, Minor: a bad key on a second call still returns the live
  // instance rather than throwing, because the active check runs first.
  it('returns the existing instance on a second call even with an invalid apiKey', () => {
    const a1 = init({ apiKey: 'k', app: 'x', mongoose, fetchImpl: okFetch });
    const a2 = init({ apiKey: '', app: 'x', mongoose, fetchImpl: okFetch });
    expect(a2).toBe(a1);
  });
});
