import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { EventEmitter } from 'node:events';
import mongoose from 'mongoose';
// Test-only: the contract is a dev dependency, used here to make a recipient
// key pair and to decrypt what the SDK sent.
import { generateSampleKeyPair, decryptSample } from '@query-analyser/contract/runtime';
import sdkDefault, { init, instrument, shutdown } from './index.js';
import * as drivers from './drivers.js';
import { CONNECT_WRAP, MONITORING_OFF_WARNING, resolvePeer } from './drivers.js';
import { PG_QUERY_WRAP, PG_POOL_QUERY_WRAP } from './integrations/pg.js';
import { PRISMA_HOOK } from './integrations/prisma.js';
import { sqlRuntime } from './sql/context.js';
import { maskName } from './sql/fingerprint.js';
import { currentSink } from './monitor.js';
import { buildSignature, type SignatureResult } from './signature.js';
import { MAX_CHUNK_BYTES } from './transport.js';

afterEach(async () => { await shutdown(); });

const okFetch = () => Promise.resolve(new Response('{}', { status: 202 }));

class FakeClient extends EventEmitter { options = { monitorCommands: true }; }
const fakeClient = () => new FakeClient();
/** Driver 4+ shape with monitoring off: options.monitorCommands false plus a setter. */
class Fake4 extends EventEmitter {
  options = { monitorCommands: false };
  get monitorCommands() { return this.options.monitorCommands; }
  set monitorCommands(v: boolean) { this.options.monitorCommands = v; }
}
let rid = 1_000_000;
/** A paired find start and success of 150 ms. */
function emitFind(c: EventEmitter, coll: string, filter: object, db = 'app'): void {
  const requestId = ++rid;
  c.emit('commandStarted', { requestId, connectionId: 1, databaseName: db, commandName: 'find', command: { find: coll, filter } });
  c.emit('commandSucceeded', { requestId, connectionId: 1, duration: 150, commandName: 'find', reply: { ok: 1, cursor: { id: 0, firstBatch: [] } } });
}
const warnings = (onError: { mock: { calls: unknown[][] } }) =>
  onError.mock.calls.filter(([e]) => (e as Error).message === MONITORING_OFF_WARNING);
/** Every item of every request body. */
function sentItems(fetchImpl: { mock: { calls: unknown[][] } }): Record<string, unknown>[] {
  return fetchImpl.mock.calls.flatMap((_, n) => (JSON.parse(bodyText(fetchImpl, n)) as { items: Record<string, unknown>[] }).items);
}
/** An unconnected mongoose connection with a database name, so its models are resolvable without a server. */
function lateConnection() {
  const conn = mongoose.createConnection();
  (conn as unknown as { name: string }).name = 'latedb';
  return conn;
}

/**
 * `_aggregator` is a test-only seam on the internal analyser (not part of
 * the public Analyser type) that lets these unit tests put content into the
 * aggregator directly, since there is no live mongoose connection here to
 * produce it via real queries.
 */
type Seedable = {
  _aggregator: {
    add(sig: SignatureResult, ms: number, sample: unknown, rawSample?: unknown): void;
    swap(): { items: unknown[]; dropped: number };
    merge(items: unknown[]): void;
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

  it('resolves a model registered after init()', async () => {
    const c = fakeClient(); const fetchImpl = vi.fn(okFetch);
    const a = init({ apiKey: 'k', app: 'x', mongoose, mongoClient: c, fetchImpl });
    // A find before the model exists builds the resolver's index first, so
    // the later lookup has to rebuild on its miss.
    emitFind(c, `other_${Date.now()}`, { a: 1 });
    const M = lateConnection().model(`Late_${Date.now()}`, new mongoose.Schema({ a: Number }));
    emitFind(c, M.collection.collectionName, { a: 1 }, M.db.name);
    await a.flush();
    const late = sentItems(fetchImpl).find((i) => i.collection === M.collection.collectionName);
    expect(late).toMatchObject({ model: M.modelName, collection: M.collection.collectionName });
  });

  it('does nothing at all when disabled', () => {
    const fetchImpl = vi.fn(okFetch);
    const a = init({ apiKey: 'k', app: 'x', enabled: false, mongoose, fetchImpl });
    expect(a.installedModels).toBe(0);
    expect(currentSink()).toBeNull();
    expect(CONNECT_WRAP in mongoose.mongo.MongoClient.prototype).toBe(false);
    expect(CONNECT_WRAP in (resolvePeer('mongodb') as typeof mongoose.mongo).MongoClient.prototype).toBe(false);
  });

  it('a repeated init() while disabled does not watch the clients it is given', () => {
    init({ apiKey: 'k', app: 'x', enabled: false, mongoose, fetchImpl: okFetch });
    const c = new Fake4();
    init({ apiKey: 'k', app: 'x', enabled: false, mongoose, mongoClient: c, fetchImpl: okFetch });
    expect(c.listenerCount('commandStarted')).toBe(0);
    expect(c.options.monitorCommands).toBe(false);
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

  // Replaces "never throws when mongoose.models is a throwing getter": init()
  // reaches mongoose only through `connections` now (model registry and
  // client discovery). A getter that throws must never crash the boot file.
  it('never throws when mongoose.connections is a throwing getter, and still returns a usable Analyser', async () => {
    const fake = { get connections(): never { throw new Error('boom'); } };
    const onError = vi.fn();
    let a: ReturnType<typeof init> | undefined;
    expect(() => { a = init({ apiKey: 'k', app: 'x', mongoose: fake, fetchImpl: okFetch, onError }); }).not.toThrow();
    expect(a).toBeDefined();
    expect(a!.installedModels).toBe(0);
    const fetchImpl = vi.fn(okFetch);
    await a!.shutdown();
    const b = init({ apiKey: 'k', app: 'x', mongoose: fake, fetchImpl });
    seed(b);
    await b.flush();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
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

/** The JSON text of the n-th request body, gunzipped when the transport compressed it. */
function bodyText(fetchImpl: { mock: { calls: unknown[][] } }, n = 0): string {
  const init = fetchImpl.mock.calls[n]![1] as RequestInit;
  const gz = (init.headers as Record<string, string>)['Content-Encoding'] === 'gzip';
  return gz ? gunzipSync(init.body as Buffer).toString('utf8') : String(init.body);
}

const WIRE_ITEM_KEYS = [
  'signature', 'hash', 'model', 'operation', 'filterShape', 'sortKeys', 'stages',
  'count', 'totalMs', 'maxMs', 'lastMs', 'lastTs', 'hist', 'sample', 'source', 'collection',
];

describe('driver layer', () => {
  it('wraps connect of the resolved mongodb and of mongoose.mongo, and shutdown() restores it', async () => {
    init({ apiKey: 'k', app: 'x', mongoose, fetchImpl: okFetch });
    expect(CONNECT_WRAP in mongoose.mongo.MongoClient.prototype).toBe(true);
    expect(CONNECT_WRAP in (resolvePeer('mongodb') as typeof mongoose.mongo).MongoClient.prototype).toBe(true);
    await shutdown();
    expect(CONNECT_WRAP in mongoose.mongo.MongoClient.prototype).toBe(false);
    expect(CONNECT_WRAP in (resolvePeer('mongodb') as typeof mongoose.mongo).MongoClient.prototype).toBe(false);
  });

  it('shutdown() clears the sink it set, and only its own', async () => {
    const a = init({ apiKey: 'k', app: 'x', mongoose, fetchImpl: okFetch });
    expect(currentSink()).not.toBeNull();
    await a.shutdown();
    expect(currentSink()).toBeNull();
  });

  it('warns once, naming monitorCommands: true, for a mongoClient whose monitoring is off', () => {
    const onError = vi.fn(); const c = new Fake4();
    init({ apiKey: 'k', app: 'x', mongoose, mongoClient: [c, c], fetchImpl: okFetch, onError });
    expect(onError.mock.calls.filter(([e]) => (e as Error).message === MONITORING_OFF_WARNING)).toHaveLength(1);
    expect(MONITORING_OFF_WARNING).toContain('`monitorCommands: true`');
    expect(MONITORING_OFF_WARNING).toContain('if this client was already connected');
    // init() switched it on for any later connect.
    expect(c.options.monitorCommands).toBe(true);
    expect(c.listenerCount('commandStarted')).toBe(1);
  });

  it('does not warn for a mongoClient whose monitoring is on', () => {
    const onError = vi.fn();
    init({ apiKey: 'k', app: 'x', mongoose, mongoClient: fakeClient(), fetchImpl: okFetch, onError });
    expect(onError).not.toHaveBeenCalled();
  });

  it('instrument() on the same client on every invocation attaches once and warns at most once', async () => {
    const onError = vi.fn(); const fetchImpl = vi.fn(okFetch);
    const a = init({ apiKey: 'k', app: 'x', mongoose, fetchImpl, onError });
    const c = new Fake4();
    for (let i = 0; i < 5; i++) instrument(c);
    for (const ev of ['commandStarted', 'commandSucceeded', 'commandFailed']) expect(c.listenerCount(ev)).toBe(1);
    expect(warnings(onError)).toHaveLength(1);
    const coll = `serverless_${Date.now()}`;
    emitFind(c, coll, { a: 1 });
    await a.flush();
    const items = sentItems(fetchImpl);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ collection: coll, count: 1 });
  });

  it('instrument() warns at most once per client even while its monitoring stays off', () => {
    const onError = vi.fn();
    init({ apiKey: 'k', app: 'x', mongoose, fetchImpl: okFetch, onError });
    // A setter that never takes effect: monitorState stays 'off' every call.
    class Stubborn extends EventEmitter {
      options = { monitorCommands: false };
      get monitorCommands() { return false; }
      set monitorCommands(_v: boolean) { /* ignored */ }
    }
    const c = new Stubborn();
    for (let i = 0; i < 5; i++) instrument(c);
    expect(warnings(onError)).toHaveLength(1);
    expect(c.listenerCount('commandSucceeded')).toBe(1);
  });

  it('instrument() captures a client from a driver copy the SDK cannot reach', async () => {
    const fetchImpl = vi.fn(okFetch);
    const a = init({ apiKey: 'k', app: 'x', mongoose, fetchImpl });
    const c = fakeClient(); // no prototype the SDK wrapped
    instrument(c);
    const coll = `unreached_${Date.now()}`;
    emitFind(c, coll, { a: 1 });
    await a.flush();
    const items = sentItems(fetchImpl);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ model: coll, collection: coll });
  });

  it('a mongoClient from a driver copy the SDK cannot reach is captured', async () => {
    const fetchImpl = vi.fn(okFetch);
    const c = fakeClient();
    const a = init({ apiKey: 'k', app: 'x', mongoose, mongoClient: c, fetchImpl });
    const coll = `unreached_opt_${Date.now()}`;
    emitFind(c, coll, { a: 1 });
    await a.flush();
    expect(sentItems(fetchImpl)).toHaveLength(1);
    expect(sentItems(fetchImpl)[0]).toMatchObject({ model: coll, collection: coll });
  });

  it('instrument() before init() is picked up once init() runs', async () => {
    const c = fakeClient();
    instrument(c);
    const fetchImpl = vi.fn(okFetch);
    const a = init({ apiKey: 'k', app: 'x', mongoose, fetchImpl });
    const coll = `early_${Date.now()}`;
    emitFind(c, coll, { a: 1 });
    await a.flush();
    expect(sentItems(fetchImpl)).toHaveLength(1);
    expect(c.listenerCount('commandSucceeded')).toBe(1);
  });

  it('instrument() before init() writes the monitoring-off warning to stderr', () => {
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      instrument(new Fake4());
      const lines = write.mock.calls.map(([t]) => String(t));
      expect(lines.filter((l) => l.includes(MONITORING_OFF_WARNING))).toHaveLength(1);
    } finally {
      write.mockRestore();
    }
  });

  it('instrument() never throws', () => {
    init({ apiKey: 'k', app: 'x', mongoose, fetchImpl: okFetch, onError: () => { throw new Error('onError boom'); } });
    const hostile = new Proxy({}, { get() { throw new Error('get boom'); }, getPrototypeOf() { throw new Error('proto boom'); } });
    expect(() => instrument(hostile)).not.toThrow();
    expect(() => instrument(null as unknown as object)).not.toThrow();
    expect(() => instrument({ on() { throw new Error('on boom'); } })).not.toThrow();
  });

  it('a repeated init() still watches the clients it is given', async () => {
    const onError = vi.fn(); const fetchImpl = vi.fn(okFetch);
    const A = fakeClient();
    const a = init({ apiKey: 'k', app: 'x', mongoose, mongoClient: A, fetchImpl, onError });
    const B = new Fake4(); // created lazily, monitoring off
    for (let i = 0; i < 3; i++) {
      expect(init({ apiKey: 'k', app: 'x', mongoose, mongoClient: [B], fetchImpl, onError })).toBe(a);
    }
    for (const ev of ['commandStarted', 'commandSucceeded', 'commandFailed']) expect(B.listenerCount(ev)).toBe(1);
    expect(B.options.monitorCommands).toBe(true);
    expect(warnings(onError)).toHaveLength(1);
    const coll = `repeat_${Date.now()}`;
    emitFind(B, coll, { a: 1 });
    await a.flush();
    const items = sentItems(fetchImpl);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ collection: coll, count: 1 });
  });

  it('a client attached in one init() cycle is captured again after shutdown() and a new init()', async () => {
    const c = fakeClient();
    init({ apiKey: 'k', app: 'x', mongoose, mongoClient: c, fetchImpl: okFetch });
    await shutdown();
    const fetchImpl = vi.fn(okFetch);
    const b = init({ apiKey: 'k', app: 'x', mongoose, fetchImpl });
    const coll = `cycle_${Date.now()}`;
    emitFind(c, coll, { a: 1 });
    await b.flush();
    expect(sentItems(fetchImpl)).toHaveLength(1);
    expect(c.listenerCount('commandSucceeded')).toBe(1);
  });

  it('a stale instance shutdown() leaves the newer sink and connect wraps in place', async () => {
    const a = init({ apiKey: 'k', app: 'x', mongoose, fetchImpl: okFetch });
    await a.shutdown();
    const b = init({ apiKey: 'k', app: 'x', mongoose, fetchImpl: okFetch });
    const sinkB = currentSink();
    expect(sinkB).not.toBeNull();
    await a.shutdown();
    expect(currentSink()).toBe(sinkB);
    expect(CONNECT_WRAP in mongoose.mongo.MongoClient.prototype).toBe(true);
    expect(CONNECT_WRAP in (resolvePeer('mongodb') as typeof mongoose.mongo).MongoClient.prototype).toBe(true);
    expect(init({ apiKey: 'k', app: 'x' })).toBe(b);
  });

  it('the default export carries init, shutdown and instrument', () =>
    expect(Object.keys(sdkDefault).sort()).toEqual(['init', 'instrument', 'shutdown']));
});

describe('encrypted samples', () => {
  const sigFor = (key: string) => buildSignature({ model: 'M', operation: 'find', filter: { [key]: 1 } });

  it('without sampleKey the payload has no encryptedSample key and never the raw values', async () => {
    const fetchImpl = vi.fn(okFetch);
    const a = init({ apiKey: 'k', app: 'x', mongoose, fetchImpl });
    const agg = (a as unknown as Seedable)._aggregator;
    agg.add(sigFor('email'), 150, { filter: { email: '<string>' } }, { filter: { email: 'ana@secret.test' } });
    await a.flush();

    const text = bodyText(fetchImpl);
    expect(text).not.toContain('encryptedSample');
    expect(text).not.toContain('sampleText');
    expect(text).not.toContain('ana@secret.test');
    const sent = JSON.parse(text) as { items: Record<string, unknown>[] };
    expect(Object.keys(sent.items[0]!)).toEqual(WIRE_ITEM_KEYS);
  });

  it('with sampleKey it sends an envelope that decrypts to the slowest call\'s real filter', async () => {
    const { publicKey, privateKey } = await generateSampleKeyPair();
    const onError = vi.fn();
    const fetchImpl = vi.fn(okFetch);
    const a = init({ apiKey: 'k', app: 'x', mongoose, fetchImpl, onError, sampleKey: publicKey });
    const agg = (a as unknown as Seedable)._aggregator;
    const sig = sigFor('email');
    agg.add(sig, 150, { filter: { email: '<string>' } }, { filter: { email: 'fast@secret.test' } });
    agg.add(sig, 900, { filter: { email: '<string>' } }, { filter: { email: 'slow@secret.test' } });
    await a.flush();

    const text = bodyText(fetchImpl);
    expect(text).not.toContain('secret.test');
    expect(text).not.toContain('sampleText');
    const sent = JSON.parse(text) as { items: { sample: unknown; encryptedSample: Parameters<typeof decryptSample>[1] }[] };
    const item = sent.items[0]!;
    expect(item.sample).toEqual({ filter: { email: '<string>' } });
    expect(item.encryptedSample).toMatchObject({ v: 1 });
    const plain = await decryptSample(privateKey, item.encryptedSample);
    expect(JSON.parse(plain)).toEqual({ filter: { email: 'slow@secret.test' } });
    expect(onError).not.toHaveBeenCalled();
  });

  it('skips (null) a sample whose serialised form is over 16 KiB, without an error', async () => {
    const { publicKey } = await generateSampleKeyPair();
    const onError = vi.fn();
    const fetchImpl = vi.fn(okFetch);
    const a = init({ apiKey: 'k', app: 'x', mongoose, fetchImpl, onError, sampleKey: publicKey });
    (a as unknown as Seedable)._aggregator.add(sigFor('big'), 150, null, { filter: { big: 'x'.repeat(20_000) } });
    await a.flush();

    const sent = JSON.parse(bodyText(fetchImpl)) as { items: { encryptedSample: unknown }[] };
    expect(sent.items[0]!.encryptedSample).toBeNull();
    expect(onError).not.toHaveBeenCalled();
  });

  it('on an encryption failure reports onError once and still sends the batch with encryptedSample: null', async () => {
    const { publicKey } = await generateSampleKeyPair();
    const onError = vi.fn();
    const fetchImpl = vi.fn(okFetch);
    const a = init({ apiKey: 'k', app: 'x', mongoose, fetchImpl, onError, sampleKey: publicKey });
    const agg = (a as unknown as Seedable)._aggregator;
    const encrypt = vi.spyOn(globalThis.crypto.subtle, 'encrypt').mockRejectedValue(new Error('gcm exploded'));
    try {
      agg.add(sigFor('a'), 150, null, { filter: { a: 1 } });
      agg.add(sigFor('b'), 150, null, { filter: { b: 2 } });
      await a.flush();
      agg.add(sigFor('c'), 150, null, { filter: { c: 3 } });
      await a.flush();
    } finally {
      encrypt.mockRestore();
    }

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const first = JSON.parse(bodyText(fetchImpl, 0)) as { items: { encryptedSample: unknown }[] };
    expect(first.items).toHaveLength(2);
    expect(first.items.map((i) => i.encryptedSample)).toEqual([null, null]);
    const second = JSON.parse(bodyText(fetchImpl, 1)) as { items: { encryptedSample: unknown }[] };
    expect(second.items[0]!.encryptedSample).toBeNull();
    // One distinct cause, reported once across both flushes.
    expect(onError).toHaveBeenCalledTimes(1);
    expect((onError.mock.calls[0]![0] as Error).message).toMatch(/gcm exploded/);
  });

  it('an invalid sampleKey reports onError once and runs without encryption', async () => {
    const onError = vi.fn();
    const fetchImpl = vi.fn(okFetch);
    const a = init({ apiKey: 'k', app: 'x', mongoose, fetchImpl, onError, sampleKey: 'not-a-real-key' });
    const agg = (a as unknown as Seedable)._aggregator;
    agg.add(sigFor('a'), 150, null, { filter: { a: 'ana@secret.test' } });
    await a.flush();
    agg.add(sigFor('b'), 150, null, { filter: { b: 'ana@secret.test' } });
    await a.flush();

    expect(onError).toHaveBeenCalledTimes(1);
    expect((onError.mock.calls[0]![0] as Error).message).toMatch(/sampleKey/);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    for (const n of [0, 1]) {
      const text = bodyText(fetchImpl, n);
      expect(text).not.toContain('encryptedSample');
      expect(text).not.toContain('secret.test');
    }
  });

  it('sends only IngestItem keys and never the plaintext, with and without sampleKey', async () => {
    const { publicKey } = await generateSampleKeyPair();
    for (const sampleKey of [undefined, publicKey]) {
      const fetchImpl = vi.fn(okFetch);
      const a = init({ apiKey: 'k', app: 'x', mongoose, fetchImpl, onError: () => {}, sampleKey });
      (a as unknown as Seedable)._aggregator.add(sigFor('email'), 150, { filter: { email: '<string>' } }, { filter: { email: 'ana@secret.test' } });
      await a.flush();
      const text = bodyText(fetchImpl);
      expect(text).not.toContain('ana@secret.test');
      expect(text).not.toContain('sampleText');
      const sent = JSON.parse(text) as { items: Record<string, unknown>[] };
      const allowed = sampleKey ? [...WIRE_ITEM_KEYS, 'encryptedSample'] : WIRE_ITEM_KEYS;
      for (const item of sent.items) expect(Object.keys(item)).toEqual(allowed);
      await shutdown();
    }
  });

  it('on retry re-encrypts from the stored string (fresh envelope, same plaintext)', async () => {
    const { publicKey, privateKey } = await generateSampleKeyPair();
    let calls = 0;
    const fetchImpl = vi.fn(async (_u: Parameters<typeof fetch>[0], _i?: Parameters<typeof fetch>[1]) => {
      calls++;
      return calls === 1 ? new Response('unavailable', { status: 503 }) : new Response('{}', { status: 202 });
    });
    const a = init({ apiKey: 'k', app: 'x', mongoose, fetchImpl, onError: () => {}, sampleKey: publicKey });
    const agg = (a as unknown as Seedable)._aggregator;
    const raw = { filter: { email: 'retry@secret.test' } };
    agg.add(sigFor('email'), 300, null, raw);
    await a.flush();
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    // The merged-back item holds the bounded string, not the filter object.
    const held = agg.swap().items as { sampleText?: unknown }[];
    expect(held).toHaveLength(1);
    expect(held[0]!.sampleText).toBe('{"filter":{"email":"retry@secret.test"}}');
    expect(Object.values(held[0]!)).not.toContain(raw);
    agg.merge(held);

    await a.shutdown();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    type Sent = { items: { encryptedSample: Parameters<typeof decryptSample>[1] }[] };
    const first = JSON.parse(bodyText(fetchImpl, 0)) as Sent;
    const second = JSON.parse(bodyText(fetchImpl, 1)) as Sent;
    expect(second.items).toHaveLength(1);
    expect(second.items[0]!.encryptedSample.epk).not.toBe(first.items[0]!.encryptedSample.epk);
    expect(JSON.parse(await decryptSample(privateKey, second.items[0]!.encryptedSample))).toEqual(raw);
  });

  it('caps the envelopes in one flush so 150 x 16 KiB samples stay under the 2 MiB body limit', async () => {
    const { publicKey } = await generateSampleKeyPair();
    const fetchImpl = vi.fn(okFetch);
    const a = init({ apiKey: 'k', app: 'x', mongoose, fetchImpl, onError: () => {}, sampleKey: publicKey });
    const agg = (a as unknown as Seedable)._aggregator;
    for (let i = 0; i < 150; i++) {
      agg.add(sigFor(`k${i}`), 100 + i, null, { filter: { v: String(i).padEnd(16_300, 'x') } });
    }
    await a.flush();

    const text = bodyText(fetchImpl);
    expect(Buffer.byteLength(text)).toBeLessThan(2 * 1024 * 1024);
    const sent = JSON.parse(text) as { items: { maxMs: number; encryptedSample: { ct: string } | null }[] };
    expect(sent.items).toHaveLength(150);
    const withEnvelope = sent.items.filter((i) => i.encryptedSample !== null);
    expect(withEnvelope.length).toBeGreaterThan(0);
    expect(withEnvelope.length).toBeLessThan(150);
    expect(withEnvelope.reduce((n, i) => n + i.encryptedSample!.ct.length, 0)).toBeLessThanOrEqual(1_048_576);
    // The slowest items get the budget first.
    const minWith = Math.min(...withEnvelope.map((i) => i.maxMs));
    const maxWithout = Math.max(...sent.items.filter((i) => i.encryptedSample === null).map((i) => i.maxMs));
    expect(minWith).toBeGreaterThan(maxWithout);
  });

  it('never makes init() throw, whatever the sampleKey', async () => {
    for (const sampleKey of ['', '!!!', 'A'.repeat(10_000)]) {
      expect(() => init({ apiKey: 'k', app: 'x', mongoose, fetchImpl: okFetch, onError: () => {}, sampleKey })).not.toThrow();
      await shutdown();
    }
  });
});

describe('chunked flushes', () => {
  // A realistic, wide signature: long key names make each item ~400 B.
  const wideSig = (i: number) => buildSignature({
    model: 'Order', operation: 'find',
    filter: Object.fromEntries(Array.from({ length: 8 }, (_, k) => [`customer_profile_field_${k}_${i}`, 1])),
  });
  type Sent = { dropped: number; items: { hash: string; encryptedSample?: unknown }[] };
  const allBodies = (fetchImpl: { mock: { calls: unknown[][] } }) =>
    fetchImpl.mock.calls.map((_, n) => bodyText(fetchImpl, n));

  async function flushMany(sampleKey: string | undefined, count: number) {
    const fetchImpl = vi.fn(okFetch);
    const a = init({ apiKey: 'k', app: 'x', mongoose, fetchImpl, onError: () => {}, sampleKey });
    const agg = (a as unknown as Seedable)._aggregator;
    const hashes: string[] = [];
    for (let i = 0; i < count; i++) {
      const sig = wideSig(i);
      hashes.push(sig.hash);
      agg.add(sig, 150, { filter: { email: '<string>' } }, { filter: { email: `user${i}@secret.test`, n: i } });
    }
    await a.flush();
    return { fetchImpl, hashes };
  }

  for (const withKey of [true, false]) {
    it(`5000 signatures ${withKey ? 'with' : 'without'} a key: every POST body is within the chunk limit and every item is delivered once`, async () => {
      const sampleKey = withKey ? (await generateSampleKeyPair()).publicKey : undefined;
      const { fetchImpl, hashes } = await flushMany(sampleKey, 5000);
      const bodies = allBodies(fetchImpl);
      expect(bodies.length).toBeGreaterThan(1);
      for (const b of bodies) expect(Buffer.byteLength(b)).toBeLessThanOrEqual(MAX_CHUNK_BYTES);
      const delivered = bodies.flatMap((b) => (JSON.parse(b) as Sent).items.map((i) => i.hash));
      expect(delivered.length).toBe(5000);
      expect(new Set(delivered)).toEqual(new Set(hashes));
      if (withKey) {
        const envelopes = bodies.flatMap((b) => (JSON.parse(b) as Sent).items.filter((i) => i.encryptedSample));
        expect(envelopes.length).toBeGreaterThan(0);
      } else {
        for (const b of bodies) expect(b).not.toContain('encryptedSample');
      }
    }, 60_000);
  }

  it('retries only the failed chunk: chunk 1 is never sent twice', async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async (_u: Parameters<typeof fetch>[0], _i?: Parameters<typeof fetch>[1]) => {
      calls++;
      return calls === 2 ? new Response('unavailable', { status: 503 }) : new Response('{}', { status: 202 });
    });
    const a = init({ apiKey: 'k', app: 'x', mongoose, fetchImpl, onError: () => {} });
    const agg = (a as unknown as Seedable)._aggregator;
    const hashes: string[] = [];
    for (let i = 0; i < 5000; i++) {
      const sig = wideSig(i);
      hashes.push(sig.hash);
      agg.add(sig, 150, { filter: { email: '<string>' } });
    }
    await a.flush();
    const sentInFlush = fetchImpl.mock.calls.length;
    expect(sentInFlush).toBe(2); // chunk 1 ok, chunk 2 failed -> stop and back off

    await a.shutdown();          // resets backoff and drains the merged-back remainder
    const bodies = allBodies(fetchImpl);
    const okBodies = bodies.filter((_, n) => n !== 1);
    const delivered = okBodies.flatMap((b) => (JSON.parse(b) as Sent).items.map((i) => i.hash));
    expect(delivered.length).toBe(5000);
    expect(new Set(delivered)).toEqual(new Set(hashes));
  }, 60_000);

  it('without a key, a small batch is exactly one POST with the same payload as before', async () => {
    const fetchImpl = vi.fn(okFetch);
    const a = init({ apiKey: 'k', app: 'x', mongoose, fetchImpl, env: 'test' });
    const sig = wideSig(1);
    (a as unknown as Seedable)._aggregator.add(sig, 150, { filter: { a: '<number>' } });
    await a.flush();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const text = bodyText(fetchImpl);
    const sent = JSON.parse(text) as Record<string, unknown> & { items: Record<string, unknown>[] };
    expect(Object.keys(sent)).toEqual(['app', 'env', 'host', 'sdkVersion', 'bucket', 'thresholdMs', 'dropped', 'items']);
    expect(sent.items).toHaveLength(1);
    expect(Object.keys(sent.items[0]!)).toEqual(WIRE_ITEM_KEYS);
    expect(sent.items[0]).toMatchObject({ hash: sig.hash, signature: sig.signature, count: 1, maxMs: 150, sample: { filter: { a: '<number>' } } });
    expect(sent.items[0]).toMatchObject({ source: 'mongodb', collection: 'Order' });
    expect(text).toBe(JSON.stringify(sent));
  });

  it('drops (and reports) a single item too big for any chunk, delivering the rest', async () => {
    const onError = vi.fn();
    const fetchImpl = vi.fn(okFetch);
    const a = init({ apiKey: 'k', app: 'x', mongoose, fetchImpl, onError });
    const agg = (a as unknown as Seedable)._aggregator;
    const small = wideSig(1);
    agg.add(small, 150, null);
    agg.add(wideSig(2), 150, { blob: 'x'.repeat(MAX_CHUNK_BYTES) });
    await a.flush();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const sent = JSON.parse(bodyText(fetchImpl)) as Sent;
    expect(sent.items.map((i) => i.hash)).toEqual([small.hash]);
    expect(onError).toHaveBeenCalledTimes(1);
    expect((onError.mock.calls[0]![0] as Error).message).toMatch(/too large/);
  });
});

describe('sql layers', () => {
  const g = globalThis as unknown as Record<string, any>;
  const SAMPLE_RATE_WARNING = 'query-analyser: sql.sampleRate must be a number greater than 0 and at most 1; using 1';
  const engineWarning = (version: string) =>
    `query-analyser: @prisma/client ${version} without @prisma/adapter-pg runs its SQL inside the query engine, which the SDK captures only when your app already enables Prisma tracing. Use @prisma/adapter-pg, or Prisma 7, to capture these queries.`;
  const messages = (onError: { mock: { calls: unknown[][] } }) => onError.mock.calls.map(([e]) => (e as Error).message);
  const stmt = (text: string, durationMs = 3) =>
    ({ text, database: 'd', durationMs, failed: false, errorCode: null, labels: null });
  /** A pg-shaped module of fresh classes (never the real pg), so a test owns its prototypes. */
  const fakePg = () => {
    class Client { connectionParameters = {}; query() { return Promise.resolve({}); } }
    class Pool { Client = Client; query() { return Promise.resolve({}); } }
    return { Client, Pool };
  };

  afterEach(() => { vi.restoreAllMocks(); });
  // Decision 18's once-per-process flag lives on the runtime, so each test starts unwarned.
  beforeEach(() => { sqlRuntime().engineWarningReported = false; });

  it('init() wraps the resolved pg Client.prototype.query, and shutdown() restores it', async () => {
    const pg = createRequire(import.meta.url)('pg');
    init({ apiKey: 'k', app: 'x', fetchImpl: okFetch });
    expect(PG_QUERY_WRAP in pg.Client.prototype).toBe(true);
    expect(PG_POOL_QUERY_WRAP in pg.Pool.prototype).toBe(true);
    await shutdown();
    expect(PG_QUERY_WRAP in pg.Client.prototype).toBe(false);
    expect(PG_POOL_QUERY_WRAP in pg.Pool.prototype).toBe(false);
  });

  it('init({ pg }) wraps the given module, also on a repeated init(), but not under the disabled no-op', async () => {
    const first = fakePg(); const later = fakePg(); const off = fakePg();
    init({ apiKey: 'k', app: 'x', fetchImpl: okFetch, pg: first });
    expect(PG_QUERY_WRAP in first.Client.prototype).toBe(true);
    expect(PG_POOL_QUERY_WRAP in first.Pool.prototype).toBe(true);
    init({ apiKey: 'k', app: 'x', fetchImpl: okFetch, pg: later });
    expect(PG_QUERY_WRAP in later.Client.prototype).toBe(true);
    expect(PG_POOL_QUERY_WRAP in later.Pool.prototype).toBe(true);
    await shutdown();
    expect(PG_QUERY_WRAP in first.Client.prototype).toBe(false);
    expect(PG_QUERY_WRAP in later.Client.prototype).toBe(false);
    init({ apiKey: 'k', app: 'x', fetchImpl: okFetch, enabled: false });
    init({ apiKey: 'k', app: 'x', fetchImpl: okFetch, pg: off });
    expect(PG_QUERY_WRAP in off.Client.prototype).toBe(false);
  });

  it('installs the own Prisma helper on V7 only, and shutdown() removes it', async () => {
    init({ apiKey: 'k', app: 'x', fetchImpl: okFetch });
    expect(typeof g.V7_PRISMA_INSTRUMENTATION.helper.runInChildSpan).toBe('function');
    expect(g.V7_PRISMA_INSTRUMENTATION.helper.isEnabled()).toBe(false);
    expect(g.V6_PRISMA_INSTRUMENTATION).toBeUndefined();
    expect(g.PRISMA_INSTRUMENTATION).toBeUndefined();
    await shutdown();
    expect('V7_PRISMA_INSTRUMENTATION' in globalThis).toBe(false);
    expect(PRISMA_HOOK in globalThis).toBe(false);
  });

  it('each flush re-installs a deleted watched key, but a flush after shutdown() does not', async () => {
    const a = init({ apiKey: 'k', app: 'x', fetchImpl: okFetch });
    delete g.V7_PRISMA_INSTRUMENTATION;
    await a.flush();
    expect(typeof g.V7_PRISMA_INSTRUMENTATION.helper.runInChildSpan).toBe('function');
    expect(g.V7_PRISMA_INSTRUMENTATION.helper.isEnabled()).toBe(false);
    await a.shutdown();
    await a.flush();
    expect('V7_PRISMA_INSTRUMENTATION' in globalThis).toBe(false);
    expect(PRISMA_HOOK in globalThis).toBe(false);
  });

  it('a bad sql.sampleRate is reported once and treated as 1', async () => {
    for (const sampleRate of [0, -1, 2, Number.NaN, Number.POSITIVE_INFINITY, '0.5' as unknown as number]) {
      const onError = vi.fn(); const fetchImpl = vi.fn(okFetch);
      const a = init({ apiKey: 'k', app: 'x', fetchImpl, onError, sql: { sampleRate } });
      expect(messages(onError)).toEqual([SAMPLE_RATE_WARNING]);
      for (let i = 0; i < 3; i++) sqlRuntime().sink!.record(stmt('SELECT 1 FROM t'));
      await a.flush();
      expect(messages(onError)).toEqual([SAMPLE_RATE_WARNING]);
      expect(sentItems(fetchImpl)[0]).toMatchObject({ source: 'postgresql', count: 3 });
      expect(sentItems(fetchImpl)[0]!.sampleRate).toBeUndefined();
      await shutdown();
    }
  });

  it('a valid sql.sampleRate reaches the sink without a warning', async () => {
    const onError = vi.fn(); const fetchImpl = vi.fn(okFetch);
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const a = init({ apiKey: 'k', app: 'x', fetchImpl, onError, sql: { sampleRate: 0.25 } });
    sqlRuntime().sink!.record(stmt('SELECT 1 FROM t'));
    await a.flush();
    expect(onError).not.toHaveBeenCalled();
    expect(sentItems(fetchImpl)[0]).toMatchObject({ source: 'postgresql', count: 4, sampleRate: 0.25 });
  });

  it('an invalid thresholdMs is reported once and treated as 100', async () => {
    for (const thresholdMs of [-1, -0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, '50' as unknown as number]) {
      const onError = vi.fn(); const fetchImpl = vi.fn(okFetch);
      const a = init({ apiKey: 'k', app: 'x', fetchImpl, onError, thresholdMs });
      expect(messages(onError)).toEqual(['query-analyser: thresholdMs must be a finite number of milliseconds, 0 or more (fractions are rounded); using 100']);
      sqlRuntime().sink!.record(stmt('SELECT 1 FROM t'));
      await a.flush();
      expect(onError).toHaveBeenCalledTimes(1);
      expect(JSON.parse(bodyText(fetchImpl))).toMatchObject({ thresholdMs: 100 });
      await shutdown();
    }
  });

  it('a thresholdMs over one hour is reported once and clamped to 3600000', async () => {
    for (const thresholdMs of [3_600_001, 1e10, Number.MAX_SAFE_INTEGER]) {
      const onError = vi.fn(); const fetchImpl = vi.fn(okFetch);
      const a = init({ apiKey: 'k', app: 'x', fetchImpl, onError, thresholdMs });
      expect(messages(onError)).toEqual(['query-analyser: thresholdMs must be at most 3600000 (one hour); using 3600000']);
      sqlRuntime().sink!.record(stmt('SELECT 1 FROM t'));
      await a.flush();
      expect(onError).toHaveBeenCalledTimes(1);
      expect(JSON.parse(bodyText(fetchImpl))).toMatchObject({ thresholdMs: 3_600_000 });
      await shutdown();
    }
  });

  it('a thresholdMs of exactly one hour is kept without a warning', async () => {
    const onError = vi.fn(); const fetchImpl = vi.fn(okFetch);
    const a = init({ apiKey: 'k', app: 'x', fetchImpl, onError, thresholdMs: 3_600_000 });
    sqlRuntime().sink!.record(stmt('SELECT 1 FROM t'));
    await a.flush();
    expect(onError).not.toHaveBeenCalled();
    expect(JSON.parse(bodyText(fetchImpl))).toMatchObject({ thresholdMs: 3_600_000 });
    await shutdown();
  });

  it('a fractional thresholdMs is rounded without a warning; null and undefined mean the default', async () => {
    const cases: Array<[number | null | undefined, number]> = [[1.5, 2], [0.4, 0], [99.5, 100], [250.2, 250], [null, 100], [undefined, 100], [0, 0]];
    for (const [thresholdMs, sent] of cases) {
      const onError = vi.fn(); const fetchImpl = vi.fn(okFetch);
      const a = init({ apiKey: 'k', app: 'x', fetchImpl, onError, thresholdMs: thresholdMs as number });
      sqlRuntime().sink!.record(stmt('SELECT 1 FROM t'));
      await a.flush();
      expect(onError).not.toHaveBeenCalled();
      expect(JSON.parse(bodyText(fetchImpl))).toMatchObject({ thresholdMs: sent });
      await shutdown();
    }
  });

  it('a SQL statement recorded through the runtime sink is flushed as a postgresql item', async () => {
    const fetchImpl = vi.fn(okFetch); const a = init({ apiKey: 'k', app: 'x', fetchImpl });
    sqlRuntime().sink!.record({ text: 'SELECT 1 FROM t', database: 'd', durationMs: 3, failed: false, errorCode: null, labels: null });
    await a.flush();
    expect(sentItems(fetchImpl)[0]).toMatchObject({ source: 'postgresql', model: 't', operation: 'select', count: 1 });
  });

  it('shutdown() clears the SQL sink it set, and the coverage flags', async () => {
    const a = init({ apiKey: 'k', app: 'x', fetchImpl: okFetch });
    const sink = sqlRuntime().sink;
    expect(sink).not.toBeNull();
    await a.shutdown();
    expect(sqlRuntime().sink).toBeNull();
    expect(sqlRuntime().prismaAdapterResolved).toBe(false);
    expect(sqlRuntime().pgCoversPrismaAdapter).toBe(false);
  });

  it('a stale shutdown() never clears a newer SQL sink', async () => {
    const a = init({ apiKey: 'k', app: 'x', fetchImpl: okFetch });
    await a.shutdown();
    init({ apiKey: 'k', app: 'x', fetchImpl: okFetch });
    const newer = sqlRuntime().sink;
    await a.shutdown();
    expect(sqlRuntime().sink).toBe(newer);
    expect(newer).not.toBeNull();
  });

  it('Mongo payloads are unchanged with the SQL layers active', async () => {
    const fetchImpl = vi.fn(okFetch);
    const a = init({ apiKey: 'k', app: 'x', mongoose, fetchImpl, sql: { maskIdentifiers: true, sampleRate: 0.5 } });
    expect(sqlRuntime().sink).not.toBeNull();
    const sig = seed(a);
    await a.flush();
    const items = sentItems(fetchImpl);
    expect(items).toHaveLength(1);
    expect(Object.keys(items[0]!)).toEqual(WIRE_ITEM_KEYS);
    expect(items[0]).toMatchObject({ hash: sig.hash, signature: sig.signature, model: 'M', source: 'mongodb' });
  });

  it('instrument(pool) wraps a bundled pg the SDK cannot resolve', () => {
    class Client { connectionParameters = {}; query() { return Promise.resolve({}); } }
    instrument({ Client, totalCount: 0, query() {} });
    expect(PG_QUERY_WRAP in Client.prototype).toBe(true);
  });

  it('instrument() takes a pg Client or a Pool instance, and never treats it as a MongoClient', () => {
    const onError = vi.fn();
    init({ apiKey: 'k', app: 'x', fetchImpl: okFetch, onError });
    const viaClient = fakePg(); const viaPool = fakePg();
    class EmitterPool extends EventEmitter { Client = viaPool.Client; query() { return Promise.resolve({}); } }
    instrument(new viaClient.Client());
    const pool = new EmitterPool();
    instrument(pool);
    expect(PG_QUERY_WRAP in viaClient.Client.prototype).toBe(true);
    expect(PG_QUERY_WRAP in viaPool.Client.prototype).toBe(true);
    expect(PG_POOL_QUERY_WRAP in EmitterPool.prototype).toBe(true);
    expect(pool.listenerCount('commandStarted')).toBe(0);
    expect(onError).not.toHaveBeenCalled();
  });

  it('a bundled pg given to instrument() is wrapped again by a later init(), after a shutdown()', async () => {
    const bundled = fakePg();
    instrument(new bundled.Pool());
    expect(PG_QUERY_WRAP in bundled.Client.prototype).toBe(true);
    expect(PG_POOL_QUERY_WRAP in bundled.Pool.prototype).toBe(true);
    init({ apiKey: 'k', app: 'x', fetchImpl: okFetch });
    await shutdown();
    expect(PG_QUERY_WRAP in bundled.Client.prototype).toBe(false);
    init({ apiKey: 'k', app: 'x', fetchImpl: okFetch });
    expect(PG_QUERY_WRAP in bundled.Client.prototype).toBe(true);
    expect(PG_POOL_QUERY_WRAP in bundled.Pool.prototype).toBe(true);
    await shutdown();
    // Remembered once per class, not per call.
    instrument(new bundled.Pool()); instrument(new bundled.Client());
    const seen = sqlRuntime().instrumentedPg!;
    expect(seen.clients.filter((C) => C === bundled.Client)).toHaveLength(1);
    expect(seen.pools.filter((P) => P === bundled.Pool)).toHaveLength(1);
  });

  it('instrument() never throws, whatever it is given', () => {
    const hostile = new Proxy({}, { get() { throw new Error('boom'); }, has() { throw new Error('boom'); } });
    expect(() => instrument(hostile)).not.toThrow();
    expect(() => instrument(null as unknown as object)).not.toThrow();
  });

  it('maskIdentifiers reaches the sink, keyed by sha256(qa-mask: + apiKey)', async () => {
    const fetchImpl = vi.fn(okFetch);
    const a = init({ apiKey: 'k', app: 'x', fetchImpl, sql: { maskIdentifiers: true } });
    sqlRuntime().sink!.record(stmt('SELECT 1 FROM t'));
    await a.flush();
    const item = sentItems(fetchImpl)[0]!;
    expect(String(item.model).startsWith('t_')).toBe(true);
    expect(item.model).toBe(maskName('t', createHash('sha256').update('qa-mask:k').digest()));
    expect(item.database).toBe(maskName('d', createHash('sha256').update('qa-mask:k').digest()));
    expect(JSON.stringify(item)).not.toMatch(/"t"|"d"/);
  });

  it('without maskIdentifiers, names stay readable', async () => {
    const fetchImpl = vi.fn(okFetch);
    const a = init({ apiKey: 'k', app: 'x', fetchImpl, sql: { maskIdentifiers: false } });
    sqlRuntime().sink!.record(stmt('SELECT 1 FROM t'));
    await a.flush();
    expect(sentItems(fetchImpl)[0]).toMatchObject({ model: 't', database: 'd' });
  });

  it('sets pgCoversPrismaAdapter after wrapping the adapter\'s pg, and shutdown() resets it', async () => {
    const adapterPg = fakePg();
    vi.spyOn(drivers, 'resolvePgClients').mockReturnValue({
      clients: [adapterPg.Client], pools: [adapterPg.Pool], adapterResolved: true, adapterPg,
    });
    init({ apiKey: 'k', app: 'x', fetchImpl: okFetch });
    expect(sqlRuntime().prismaAdapterResolved).toBe(true);
    expect(sqlRuntime().pgCoversPrismaAdapter).toBe(true);
    await shutdown();
    expect(sqlRuntime().prismaAdapterResolved).toBe(false);
    expect(sqlRuntime().pgCoversPrismaAdapter).toBe(false);
  });

  it('pgCoversPrismaAdapter stays false when the adapter does not resolve', () => {
    const app = fakePg();
    vi.spyOn(drivers, 'resolvePgClients').mockReturnValue({ clients: [app.Client], pools: [], adapterResolved: false });
    init({ apiKey: 'k', app: 'x', fetchImpl: okFetch });
    expect(sqlRuntime().prismaAdapterResolved).toBe(false);
    expect(sqlRuntime().pgCoversPrismaAdapter).toBe(false);
  });

  it('no engine-path warning for Prisma 7, with the adapter, or with an app helper', async () => {
    const noAdapter = { clients: [], pools: [], adapterResolved: false };
    const cases: Array<[string | null, boolean, boolean]> = [
      [null, false, false], ['7.10.0', false, false], ['6.19.3', true, false], ['6.19.3', false, true], ['8.0.0', false, false],
    ];
    for (const [version, adapterResolved, appHelper] of cases) {
      vi.spyOn(drivers, 'prismaClientVersion').mockReturnValue(version);
      vi.spyOn(drivers, 'resolvePgClients').mockReturnValue({ ...noAdapter, adapterResolved });
      if (appHelper) g.PRISMA_INSTRUMENTATION = { helper: { isEnabled: () => true } };
      const onError = vi.fn();
      init({ apiKey: 'k', app: 'x', mongoose, fetchImpl: okFetch, onError });
      expect(messages(onError).filter((m) => m.includes('without @prisma/adapter-pg'))).toEqual([]);
      await shutdown();
      delete g.PRISMA_INSTRUMENTATION;
      vi.restoreAllMocks();
      expect(sqlRuntime().engineWarningReported).toBe(false);
    }
  });

  it('the engine-path warning fires once for Prisma 6 without the adapter or app tracing', async () => {
    vi.spyOn(drivers, 'prismaClientVersion').mockReturnValue('6.19.3');
    vi.spyOn(drivers, 'resolvePgClients').mockReturnValue({ clients: [], pools: [], adapterResolved: false });
    const onError = vi.fn();
    init({ apiKey: 'k', app: 'x', mongoose, fetchImpl: okFetch, onError });
    await shutdown();
    init({ apiKey: 'k', app: 'x', mongoose, fetchImpl: okFetch, onError });
    expect(messages(onError)).toEqual([engineWarning('6.19.3')]);
    expect(sqlRuntime().engineWarningReported).toBe(true);
  });

  it('the engine-path warning is not repeated by a later init() once reported (5.x)', async () => {
    vi.spyOn(drivers, 'prismaClientVersion').mockReturnValue('5.22.0');
    vi.spyOn(drivers, 'resolvePgClients').mockReturnValue({ clients: [], pools: [], adapterResolved: false });
    const first = vi.fn();
    init({ apiKey: 'k', app: 'x', mongoose, fetchImpl: okFetch, onError: first });
    expect(messages(first)).toEqual([engineWarning('5.22.0')]);
    await shutdown();
    const second = vi.fn();
    init({ apiKey: 'k', app: 'x', mongoose, fetchImpl: okFetch, onError: second });
    expect(second).not.toHaveBeenCalled();
  });

  it('the engine-path warning trusts only an @prisma/client the app itself resolves', () => {
    const spy = vi.spyOn(drivers, 'prismaClientVersion');
    init({ apiKey: 'k', app: 'x', mongoose, fetchImpl: okFetch });
    expect(spy).toHaveBeenCalledTimes(1);
    const resolve = (spy.mock.calls[0]![0] as { resolve: (n: string) => string | null }).resolve;
    expect(resolve).toBe(drivers.resolveAppPath);
  });
});
