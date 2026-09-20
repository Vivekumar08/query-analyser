import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { gunzipSync } from 'node:zlib';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { init, shutdown } from '../index.js';
// Critical 2 test-only import: the contract is a dev dependency of the SDK
// (never a runtime one — see types.ts for why SDK source never imports it),
// used here purely to prove the SDK's real serialised output parses under
// the same schema the ingest API enforces.
import { ingestPayloadSchema } from '@query-analyser/contract';

let mongod: MongoMemoryServer;

// Unique per test-run suffix so re-running this file in the same worker (or
// alongside other files that also compile mongoose models) never collides
// with an already-registered model name and throws OverwriteModelError.
const suffix = () => `_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
}, 60_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

afterEach(async () => { await shutdown(); });

function capture() {
  const bodies: string[] = [];
  const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    // The transport gzips bodies over 1KB (see transport.ts) — recursing
    // into pipeline/filter arrays (Important 6) makes samples bigger, so a
    // multi-item payload can now cross that threshold where it didn't
    // before. Decode it the same way a real ingest server would.
    const isGzipped = (init?.headers as Record<string, string> | undefined)?.['Content-Encoding'] === 'gzip';
    const body = init?.body;
    if (isGzipped && body) {
      const buf = Buffer.isBuffer(body) ? body : Buffer.from(body as unknown as Uint8Array);
      bodies.push(gunzipSync(buf).toString('utf8'));
    } else {
      bodies.push(typeof body === 'string' ? body : String(body));
    }
    return new Response('{}', { status: 202 });
  }) as unknown as typeof fetch;
  return { bodies, fetchImpl };
}

describe('end to end', () => {
  it('captures a real find and reports it with the right shape', async () => {
    const Order = mongoose.model(`IntOrder${suffix()}`, new mongoose.Schema({ status: String, total: Number }));
    const { bodies, fetchImpl } = capture();
    // thresholdMs 0 so every query counts — real queries on an in-memory
    // server are far faster than 100ms.
    const a = init({ apiKey: 'k', app: 'int-app', thresholdMs: 0, mongoose, fetchImpl });

    await Order.find({ status: 'paid', total: { $gte: 10 } }).sort({ total: -1 }).exec();
    await a.flush();

    expect(bodies).toHaveLength(1);
    const sent = JSON.parse(bodies[0]!);
    expect(sent.app).toBe('int-app');
    expect(sent.items).toHaveLength(1);
    expect(sent.items[0]).toMatchObject({
      model: Order.modelName,
      operation: 'find',
      filterShape: [{ key: 'status', op: 'eq' }, { key: 'total', op: 'range' }],
      sortKeys: [{ key: 'total', dir: -1 }],
      count: 1,
    });
    expect(sent.items[0].hist.reduce((x: number, y: number) => x + y, 0)).toBe(1);
  });

  it('collapses many executions of one shape into one item', async () => {
    const User = mongoose.model(`IntUser${suffix()}`, new mongoose.Schema({ email: String }));
    const { bodies, fetchImpl } = capture();
    const a = init({ apiKey: 'k', app: 'int-app', thresholdMs: 0, mongoose, fetchImpl });

    for (const email of ['a@x.com', 'b@x.com', 'c@x.com']) {
      await User.findOne({ email }).exec();
    }
    await a.flush();

    const sent = JSON.parse(bodies[0]!);
    expect(sent.items).toHaveLength(1);
    expect(sent.items[0].count).toBe(3);
  });

  it('instruments a model that was compiled before init ran', async () => {
    const earlyName = `IntEarly${suffix()}`;
    const Early = mongoose.model(earlyName, new mongoose.Schema({ a: String }));
    const { bodies, fetchImpl } = capture();
    const a = init({ apiKey: 'k', app: 'int-app', thresholdMs: 0, mongoose, fetchImpl });

    await Early.find({ a: 'z' }).exec();
    await a.flush();

    expect(JSON.parse(bodies[0]!).items.some((i: { model: string }) => i.model === earlyName)).toBe(true);
  });

  it('captures an aggregate as its stage list', async () => {
    const Sale = mongoose.model(`IntSale${suffix()}`, new mongoose.Schema({ region: String, amt: Number }));
    const { bodies, fetchImpl } = capture();
    const a = init({ apiKey: 'k', app: 'int-app', thresholdMs: 0, mongoose, fetchImpl });

    await Sale.aggregate([{ $match: { region: 'IN' } }, { $group: { _id: '$region', t: { $sum: '$amt' } } }]);
    await a.flush();

    const item = JSON.parse(bodies[0]!).items[0];
    expect(item.operation).toBe('aggregate');
    expect(item.stages).toEqual(['$match', '$group']);
  });

  it('never puts a queried value in the payload', async () => {
    const Secret = mongoose.model(`IntSecret${suffix()}`, new mongoose.Schema({ email: String, pin: Number }));
    const { bodies, fetchImpl } = capture();
    const a = init({ apiKey: 'k', app: 'int-app', thresholdMs: 0, mongoose, fetchImpl });

    await Secret.find({ email: 'leak-me@example.com', pin: 987654 }).exec();
    await Secret.updateMany({ email: 'leak-me@example.com' }, { $set: { pin: 111222 } }).exec();
    await a.flush();

    const body = bodies.join('');
    expect(body).not.toContain('leak-me@example.com');
    expect(body).not.toContain('987654');
    expect(body).not.toContain('111222');
    // …but the key names are there, because those are what we analyse.
    expect(body).toContain('email');
    expect(body).toContain('pin');
  });

  // Fix round 1, Important 1 (live probe against mongoose 8.24.4): two
  // models compiled from the SAME schema instance (discriminators, or a
  // shared base schema) are a realistic case. `installHooks` marks the
  // schema INSTALLED while processing the first model, so it used to
  // return `false` for the second — and since the pre-init loop only
  // rebuilt a model's own middleware snapshot when installHooks() returned
  // `true` for THAT model, the second model's snapshot (taken at its own
  // Model.compile(), before the shared schema was ever mutated) was never
  // rebuilt, leaving it silently uninstrumented.
  it('instruments every model when two models share one schema', async () => {
    const sharedSchema = new mongoose.Schema({ a: String });
    const s = suffix();
    const ShareA = mongoose.model(`ShareA${s}`, sharedSchema);
    const ShareB = mongoose.model(`ShareB${s}`, sharedSchema);
    const { bodies, fetchImpl } = capture();
    const a = init({ apiKey: 'k', app: 'int-app', thresholdMs: 0, mongoose, fetchImpl });

    await ShareA.find({ a: 'x' }).exec();
    await ShareB.find({ a: 'y' }).exec();
    await a.flush();

    const models = JSON.parse(bodies[0]!).items.map((i: { model: string }) => i.model);
    expect(models).toContain(ShareA.modelName);
    expect(models).toContain(ShareB.modelName);
  });

  // Fix round 1, Important 2 (live probe against mongoose 8.24.4): the
  // pre/post closures installed on a model's schema used to capture the
  // `HookContext` object directly, so a model instrumented during one
  // init() cycle kept reporting into that cycle's aggregator/transport
  // forever, even across shutdown() + a brand new init() — under-reporting
  // to the new analyser and leaking the old one's aggregator indefinitely.
  it('routes a pre-existing model to the new analyser after shutdown() + init()', async () => {
    const Model = mongoose.model(`IntReinit${suffix()}`, new mongoose.Schema({ a: String }));
    const first = capture();
    const a1 = init({ apiKey: 'k1', app: 'int-app-1', thresholdMs: 0, mongoose, fetchImpl: first.fetchImpl });

    await Model.find({ a: 'x' }).exec();
    await a1.flush();
    expect(first.fetchImpl).toHaveBeenCalledTimes(1);

    await shutdown();

    const second = capture();
    const a2 = init({ apiKey: 'k2', app: 'int-app-2', thresholdMs: 0, mongoose, fetchImpl: second.fetchImpl });

    await Model.find({ a: 'y' }).exec();
    await a2.flush();

    expect(second.fetchImpl).toHaveBeenCalledTimes(1);
    // The first (now-dead) analyser must never be called again.
    expect(first.fetchImpl).toHaveBeenCalledTimes(1);
    const sentToSecond = JSON.parse(second.bodies[0]!);
    expect(sentToSecond.app).toBe('int-app-2');
    expect(sentToSecond.items).toHaveLength(1);
  });

  // Fix round 1, Important 4: the original privacy test only exercised
  // find()/updateMany() filter and update values. The product's central
  // promise — no queried value ever leaves the process — has to hold for
  // every query form the SDK instruments, so this proves it for an
  // aggregate pipeline (a secret inside a $match stage, alongside a $sort
  // stage) and for a find().sort() call, all against the real serialised
  // request bodies.
  it('never puts a queried value in the payload for aggregate pipelines or sorted finds either', async () => {
    const SecretAgg = mongoose.model(`IntSecretAgg${suffix()}`, new mongoose.Schema({ region: String, note: String }));
    const SecretSort = mongoose.model(`IntSecretSort${suffix()}`, new mongoose.Schema({ email: String, rank: Number }));
    const { bodies, fetchImpl } = capture();
    const a = init({ apiKey: 'k', app: 'int-app', thresholdMs: 0, mongoose, fetchImpl });

    await SecretAgg.aggregate([
      { $match: { note: 'agg-secret-note-4242' } },
      { $sort: { region: -1 } },
    ]);
    await SecretSort.find({ email: 'sort-secret@example.com' }).sort({ rank: -1 }).exec();
    await a.flush();

    const body = bodies.join('');
    expect(body).not.toContain('agg-secret-note-4242');
    expect(body).not.toContain('sort-secret@example.com');
    // Important 6: redact() now recurses into the pipeline's stages instead
    // of collapsing the whole array to a type summary, so field *names*
    // inside a stage ($match's "note", $sort's "region") ARE now part of the
    // sample — same as any other filter/sort key, by the same "keys are
    // transmitted by design" rule documented in the README. What must never
    // appear is the field *value*, already asserted above.
    expect(body).toContain('$match');
    expect(body).toContain('$sort');
    expect(body).toContain('"note"');
    expect(body).toContain('"region"');
    // The find().sort() form DOES keep key names (filterShape/sortKeys are
    // computed for non-aggregate ops), so this is where key-name retention
    // is actually proven for a sorted query.
    expect(body).toContain('email');
    expect(body).toContain('rank');
  });

  // Critical 2: the real bug — the SDK could accept and emit options its
  // own wire contract rejects (thresholdMs: 0, an empty NODE_ENV, a
  // maxSignatures above the items cap), each causing the ingest API to 400,
  // which transport.ts classifies as "drop the batch": silent, permanent
  // data loss. This is the test that would have caught all of it: real
  // queries, the real serialised request body, parsed against the actual
  // contract schema the ingest API enforces.
  it('produces a request body that ingestPayloadSchema accepts, for a find, an aggregate and an update in one payload, with thresholdMs: 0', async () => {
    const prevNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = ''; // the exact empty-string case Critical 2 fixed
    try {
      const Combo = mongoose.model(`IntCombo${suffix()}`, new mongoose.Schema({ status: String, region: String, amt: Number }));
      const { bodies, fetchImpl } = capture();
      const a = init({
        apiKey: 'k', app: 'int-app', thresholdMs: 0, maxSignatures: 999_999, mongoose, fetchImpl,
      });

      await Combo.find({ status: 'paid' }).exec();
      await Combo.aggregate([{ $match: { region: 'IN' } }, { $group: { _id: '$region', t: { $sum: '$amt' } } }]);
      await Combo.updateMany({ status: 'paid' }, { $set: { region: 'US' } }).exec();
      await a.flush();

      expect(bodies).toHaveLength(1);
      const parsed = JSON.parse(bodies[0]!);
      expect(() => ingestPayloadSchema.parse(parsed)).not.toThrow();
      expect(parsed.items.length).toBeGreaterThanOrEqual(2);
      expect(parsed.env).toBe('development'); // empty NODE_ENV fell through to the default
      expect(parsed.thresholdMs).toBe(0);
    } finally {
      process.env.NODE_ENV = prevNodeEnv;
    }
  });

  it('does not break the query when the endpoint is dead', async () => {
    const Live = mongoose.model(`IntLive${suffix()}`, new mongoose.Schema({ a: String }));
    const fetchImpl = (() => Promise.reject(new Error('ECONNREFUSED'))) as unknown as typeof fetch;
    const a = init({ apiKey: 'k', app: 'int-app', thresholdMs: 0, mongoose, fetchImpl, onError: () => {} });

    await expect(Live.find({ a: 'x' }).exec()).resolves.toEqual([]);
    await expect(a.flush()).resolves.toBeUndefined();
  });

  // Controller ruling (Task 8 review): the plan-authored unit test for the
  // disabled-latch was dropped because it flushed an empty buffer and so
  // never proved anything about real content. This is that assertion,
  // exercised against a real mongoose model and real slow queries: once the
  // server rejects the API key, flush() must never call fetchImpl again, and
  // the post hook must stop touching the aggregator entirely (not just
  // "stop sending" — stop accumulating).
  it('latches disabled after a 401 and never calls fetchImpl or the aggregator again', async () => {
    const Secure = mongoose.model(`IntSecret_latch${suffix()}`, new mongoose.Schema({ email: String }));
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 401 }));
    const a = init({ apiKey: 'bad-key', app: 'int-app', thresholdMs: 0, mongoose, fetchImpl, onError: () => {} });

    await Secure.find({ email: 'first@example.com' }).exec();
    await a.flush();
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    await Secure.find({ email: 'second@example.com' }).exec();
    await Secure.find({ email: 'third@example.com' }).exec();
    // The post hook should have short-circuited before touching the
    // aggregator at all — the internal buffer must still be empty.
    expect((a as unknown as { _aggregator: { size: number } })._aggregator.size).toBe(0);

    await a.flush();
    // The latch held: no second network call, ever.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
