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
type Seedable = {
  _aggregator: {
    add(sig: SignatureResult, ms: number, sample: unknown): void;
    swap(): { items: unknown[]; dropped: number };
    size: number;
  };
};

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

  // Fix round 1, Important 1 (updated in round 2): setInterval doesn't await
  // flush(), so a send() slower than flushIntervalMs could otherwise let two
  // flushes overlap, each swap()ing the buffer concurrently. The second
  // caller now joins the same in-flight send rather than bailing out or
  // racing it.
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
    // Both calls have started, but the second must have joined the
    // in-flight promise rather than starting a second network call.
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

  // Fix round 2: shutdown() must not resolve while a network send it
  // triggered (or joined) is still pending — otherwise `await shutdown();
  // process.exit(0)` would exit mid-send and drop the last window.
  it('shutdown waits for an in-flight flush', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const fetchImpl = vi.fn(async (_url: Parameters<typeof fetch>[0], _init?: Parameters<typeof fetch>[1]) => {
      await gate;
      return new Response('{}', { status: 202 });
    });
    const a = init({ apiKey: 'k', app: 'x', mongoose, fetchImpl });
    seed(a);

    void a.flush(); // starts a real flush, in flight, awaiting the gate

    let resolved = false;
    const shutdownPromise = a.shutdown().then(() => { resolved = true; });

    // Let pending microtasks run without releasing the gate; shutdown must
    // still be pending because the in-flight send has not completed.
    await Promise.resolve();
    await Promise.resolve();
    expect(resolved).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    release();
    await shutdownPromise;

    expect(resolved).toBe(true);
    // shutdown's first await joined the in-flight send; nothing was left
    // for a second network call.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  // Fix round 2: an item added to the aggregator while a flush is already
  // in flight must not be lost — swap() only took what existed at the
  // moment the in-flight flush started, so shutdown() must drain again
  // after joining it.
  it('shutdown drains items that arrived during an in-flight flush', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const fetchImpl = vi.fn(async (_url: Parameters<typeof fetch>[0], _init?: Parameters<typeof fetch>[1]) => {
      await gate;
      return new Response('{}', { status: 202 });
    });
    const a = init({ apiKey: 'k', app: 'x', mongoose, fetchImpl });
    const sigA = seed(a, 'a-item');

    void a.flush(); // swaps out item A, now in flight awaiting the gate

    const sigB = seed(a, 'b-item'); // arrives while the first flush is in flight

    release();
    await a.shutdown();

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const allBodies = fetchImpl.mock.calls
      .map((call) => String((call[1] as RequestInit).body))
      .join('\n');
    expect(allBodies).toContain(sigA.hash);
    expect(allBodies).toContain(sigB.hash);
  });

  // Fix round 3: transport.send() never rejects, but a future edit (or
  // swap()/bucketOf()/hostname() misbehaving) could throw inside doFlush.
  // Since flush() is called fire-and-forget from the interval tick and
  // beforeExit, an unhandled rejection there would crash the host process —
  // the SDK must swallow it instead.
  it('never rejects when something inside flush throws, and recovers afterward', async () => {
    const onError = vi.fn();
    const fetchImpl = vi.fn(okFetch);
    const a = init({ apiKey: 'k', app: 'x', mongoose, fetchImpl, onError });
    seed(a);

    const seedable = a as unknown as Seedable;
    const realSwap = seedable._aggregator.swap.bind(seedable._aggregator);
    seedable._aggregator.swap = () => { throw new Error('swap boom'); };

    await expect(a.flush()).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledTimes(1);
    expect((onError.mock.calls[0]![0] as Error).message).toBe('swap boom');
    expect(fetchImpl).not.toHaveBeenCalled();

    // Restore swap and seed again; a later flush must work normally,
    // proving `inFlight` was cleared by the failed attempt.
    seedable._aggregator.swap = realSwap;
    seed(a);
    await a.flush();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
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

  // Fix round 4, Critical 1: init()'s mongoose-instrumentation block reaches
  // into internals (`mg.models`, `schema.pre`, kareem's shape) that are not
  // guaranteed stable. A `models` getter that throws must never crash the
  // host's boot file.
  it('never throws when mongoose.models is a throwing getter, and still returns a usable Analyser', () => {
    const onError = vi.fn();
    const fakeMongoose = {
      plugin: () => {},
      get models(): never {
        throw new Error('models getter boom');
      },
    };
    let a: ReturnType<typeof init> | undefined;
    expect(() => {
      a = init({ apiKey: 'k', app: 'x', mongoose: fakeMongoose as unknown as Parameters<typeof init>[0]['mongoose'], fetchImpl: okFetch, onError });
    }).not.toThrow();
    expect(a).toBeDefined();
    expect(a!.installedModels).toBe(0);
    expect(onError).toHaveBeenCalled();
  });

  // Fix round 4, Critical 1: one bad model's schema (throws in pre()) must
  // not stop the other models in the same mongoose instance from being
  // instrumented.
  it('instruments the other models when one model schema throws during install', () => {
    const onError = vi.fn();
    function makeSchema(shouldThrow: boolean) {
      return {
        pre(_match: unknown, _fn: unknown) {
          if (shouldThrow) throw new Error('schema.pre boom');
          return this;
        },
        post(_match: unknown, _fn: unknown) {
          return this;
        },
      };
    }
    const fakeMongoose = {
      plugin: () => {},
      models: {
        First: { schema: makeSchema(false) },
        Middle: { schema: makeSchema(true) },
        Last: { schema: makeSchema(false) },
      },
    };
    const a = init({
      apiKey: 'k', app: 'x',
      mongoose: fakeMongoose as unknown as Parameters<typeof init>[0]['mongoose'],
      fetchImpl: okFetch, onError,
    });
    expect(a.installedModels).toBe(2);
    expect(onError).toHaveBeenCalledTimes(1);
    expect((onError.mock.calls[0]![0] as Error).message).toBe('schema.pre boom');
  });

  // Important 4: mongoose was resolved and has models, but the install loop
  // instrumented none of them — a silent "the SDK does nothing" failure
  // worth its own explicit warning, distinct from any per-model error.
  it('warns once when mongoose is resolved but zero models end up instrumented', () => {
    const onError = vi.fn();
    function throwingSchema() {
      return {
        pre() { throw new Error('always throws'); },
        post() { return this; },
      };
    }
    const fakeMongoose = {
      plugin: () => {},
      models: { A: { schema: throwingSchema() }, B: { schema: throwingSchema() } },
    };
    const a = init({
      apiKey: 'k', app: 'x',
      mongoose: fakeMongoose as unknown as Parameters<typeof init>[0]['mongoose'],
      fetchImpl: okFetch, onError,
    });
    expect(a.installedModels).toBe(0);
    // Two per-model errors, plus one "zero models instrumented" summary.
    expect(onError).toHaveBeenCalledTimes(3);
    expect(onError.mock.calls.some((c) => (c[0] as Error).message.includes('no models were instrumented'))).toBe(true);
  });

  // Important 3: calling the returned analyser's own shutdown() — the
  // natural call for a TS user — must clear module-level state exactly like
  // the module-level shutdown() does, so a later init() gets a fresh, live
  // instance instead of the same dead one.
  it('instance.shutdown() clears module state so a later init() returns a new live instance', async () => {
    mongoose.model(`ShutdownReinit_${Date.now()}`, new mongoose.Schema({ a: String }));
    const a = init({ apiKey: 'k', app: 'x', mongoose, fetchImpl: okFetch });
    await a.shutdown();

    const fetchImpl = vi.fn(okFetch);
    const b = init({ apiKey: 'k2', app: 'y', mongoose, fetchImpl });
    expect(b).not.toBe(a);
    expect(b.installedModels).toBeGreaterThan(0);

    // A second init() call with the SAME identity as `b` just returns `b`
    // (by design — see "returns the existing instance" tests above), which
    // is itself proof `b` is the genuinely live, current instance and not
    // another orphan left behind by a botched shutdown.
    const c = init({ apiKey: 'k2', app: 'y', mongoose, fetchImpl: vi.fn(okFetch) });
    expect(c).toBe(b);

    seed(b);
    await b.flush();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  // Minor fix 7: SDK_VERSION must never drift from package.json's version —
  // it's wired at build/test time via tsup's/vitest's `define`, not
  // hand-typed.
  it('SDK_VERSION matches package.json', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const pkgPath = fileURLToPath(new URL('../package.json', import.meta.url));
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version: string };
    const { SDK_VERSION } = await import('./index.js');
    expect(SDK_VERSION).toBe(pkg.version);
  });
});
