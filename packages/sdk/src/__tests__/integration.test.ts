import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { gunzipSync } from 'node:zlib';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { MongoClient } from 'mongodb';
import { init, instrument, shutdown } from '../index.js';
import { MONITORING_OFF_WARNING } from '../drivers.js';
// Critical 2 test-only import: the contract is a dev dependency of the SDK
// (never a runtime one — see types.ts for why SDK source never imports it),
// used here purely to prove the SDK's real serialised output parses under
// the same schema the ingest API enforces.
import { ingestPayloadSchema, generateSampleKeyPair, decryptSample } from '@query-analyser/contract';

let mongod: MongoMemoryServer;

// Unique per test-run suffix so re-running this file in the same worker (or
// alongside other files that also compile mongoose models) never collides
// with an already-registered model name and throws OverwriteModelError.
const suffix = () => `_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  // The documented path for an app that connects before init(): switch
  // command monitoring on in the connect options.
  await mongoose.connect(mongod.getUri(), { monitorCommands: true });
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

type SentItem = Record<string, unknown> & {
  model: string; collection: string; operation: string; count: number; filterShape: unknown;
};
function itemsOf(bodies: string[]): SentItem[] {
  return bodies.flatMap((b) => JSON.parse(b).items as SentItem[]);
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

  it('with sampleKey, a real find sends an envelope that decrypts to the cast filter, and the body still passes the contract', async () => {
    const { publicKey, privateKey } = await generateSampleKeyPair();
    const Enc = mongoose.model(`IntEnc${suffix()}`, new mongoose.Schema({ owner: mongoose.Schema.Types.ObjectId, email: String, at: Date }));
    const { bodies, fetchImpl } = capture();
    const onError = vi.fn();
    const a = init({ apiKey: 'k', app: 'int-app', thresholdMs: 0, mongoose, fetchImpl, onError, sampleKey: publicKey });

    const owner = new mongoose.Types.ObjectId();
    await Enc.find({ owner: owner.toHexString(), email: 'ana@secret.test', at: { $gte: new Date('2026-01-01T00:00:00Z') } }).exec();
    await a.flush();

    expect(onError).not.toHaveBeenCalled();
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).not.toContain('ana@secret.test');
    const parsed = ingestPayloadSchema.parse(JSON.parse(bodies[0]!));
    const env = parsed.items[0]!.encryptedSample!;
    const sample = JSON.parse(await decryptSample(privateKey, env));
    expect(sample).toEqual({
      filter: {
        owner: { $oid: owner.toHexString() },
        email: 'ana@secret.test',
        at: { $gte: { $date: '2026-01-01T00:00:00.000Z' } },
      },
    });
  });

  // ---- Driver command monitoring (Task 9) ----

  it('zero-setup: a connection opened after init() is captured with no options', async () => {
    const { bodies, fetchImpl } = capture();
    const a = init({ apiKey: 'k', app: 'int-app', thresholdMs: 0, mongoose, fetchImpl });
    const conn = await mongoose.createConnection(mongod.getUri()).asPromise();
    try {
      const Zero = conn.model(`IntZero${suffix()}`, new mongoose.Schema({ a: String }));
      await Zero.find({ a: 'x' }).exec();
      await a.flush();

      const items = itemsOf(bodies);
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({
        model: Zero.modelName,
        collection: Zero.collection.collectionName,
        operation: 'find',
        source: 'mongodb',
      });
    } finally {
      await conn.close();
    }
  });

  it('warns once, naming monitorCommands: true, for a connection opened before init() without it, and captures nothing from it', async () => {
    const conn = await mongoose.createConnection(mongod.getUri()).asPromise();
    try {
      const Early = conn.model(`IntOffEarly${suffix()}`, new mongoose.Schema({ a: String }));
      const { bodies, fetchImpl } = capture();
      const onError = vi.fn();
      const a = init({ apiKey: 'k', app: 'int-app', thresholdMs: 0, mongoose, fetchImpl, onError });

      const messages = onError.mock.calls.map(([e]) => (e as Error).message);
      expect(messages.filter((m) => m === MONITORING_OFF_WARNING)).toHaveLength(1);
      expect(MONITORING_OFF_WARNING).toContain('monitorCommands: true');

      await Early.find({ a: 'x' }).exec();
      await a.flush();
      expect(bodies).toHaveLength(0);
    } finally {
      await conn.close();
    }
  });

  // The connect wrap sets monitorCommands on a re-connect of an already
  // connected client, where it has no effect, so the 'off' check passes. The
  // client's own CMAP events then show commands running without command events.
  it('warns once for a client connected before init(), re-connected, then instrumented, and captures nothing', async () => {
    const client = new MongoClient(mongod.getUri());
    await client.connect();
    try {
      const { bodies, fetchImpl } = capture();
      const onError = vi.fn();
      const a = init({ apiKey: 'k', app: 'int-app', thresholdMs: 0, mongoose, fetchImpl, onError });
      await client.connect();
      instrument(client);
      const coll = client.db('int').collection(`reconnected${suffix()}`);
      for (let i = 0; i < 3; i++) await coll.find({ a: i }).toArray();
      await coll.findOne({ a: 1 });
      instrument(client);
      await a.flush();
      const messages = onError.mock.calls.map(([e]) => (e as Error).message);
      expect(messages.filter((m) => m === MONITORING_OFF_WARNING)).toHaveLength(1);
      expect(bodies).toHaveLength(0);
    } finally {
      await client.close();
    }
  });

  it('never warns for a client created and connected after init(), with or without instrument()', async () => {
    const { bodies, fetchImpl } = capture();
    const onError = vi.fn();
    const a = init({ apiKey: 'k', app: 'int-app', thresholdMs: 0, mongoose, fetchImpl, onError });
    const client = new MongoClient(mongod.getUri());
    await client.connect();
    try {
      instrument(client);
      const name = `fresh${suffix()}`;
      const coll = client.db('int').collection(name);
      for (let i = 0; i < 5; i++) await coll.find({ a: i }).toArray();
      await client.connect();
      instrument(client);
      await a.flush();
      expect(onError).not.toHaveBeenCalled();
      expect(itemsOf(bodies).find((i) => i.collection === name)).toMatchObject({ operation: 'find', count: 5 });
    } finally {
      await client.close();
    }
    expect(onError).not.toHaveBeenCalled();
  });

  it('captures the raw driver: a MongoClient from the app\'s own mongodb is captured under the collection name', async () => {
    const { bodies, fetchImpl } = capture();
    const a = init({ apiKey: 'k', app: 'int-app', thresholdMs: 0, mongoose, fetchImpl });
    const client = new MongoClient(mongod.getUri());
    await client.connect();
    try {
      await client.db('rawdb').collection('orders').find({ status: 'x' }).toArray();
      await a.flush();

      const items = itemsOf(bodies);
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({
        model: 'orders',
        collection: 'orders',
        source: 'mongodb',
        operation: 'find',
        filterShape: [{ key: 'status', op: 'eq' }],
      });
    } finally {
      await client.close();
    }
  });

  it('useDb() models resolve through otherDbs even when another db uses the same collection name', async () => {
    const s = suffix();
    const IntA = mongoose.model(`IntA${s}`, new mongoose.Schema({ a: String }, { collection: 'shared_x' }));
    const tenant = mongoose.connection.useDb(`tenant_x${s}`);
    const IntB = tenant.model(`IntB${s}`, new mongoose.Schema({ a: String }, { collection: 'shared_x' }));
    const { bodies, fetchImpl } = capture();
    const a = init({ apiKey: 'k', app: 'int-app', thresholdMs: 0, mongoose, fetchImpl });

    await IntA.find({ a: 'x' }).exec();
    await IntB.find({ a: 'y' }).exec();
    await a.flush();

    const items = itemsOf(bodies);
    expect(items.map((i) => i.model).sort()).toEqual([IntA.modelName, IntB.modelName].sort());
    expect(items.every((i) => i.collection === 'shared_x')).toBe(true);
  });

  it('two connections to different dbs resolve each model on the same collection name', async () => {
    const s = suffix();
    const { bodies, fetchImpl } = capture();
    const a = init({ apiKey: 'k', app: 'int-app', thresholdMs: 0, mongoose, fetchImpl });
    const connA = await mongoose.createConnection(mongod.getUri(), { dbName: `dba${s}` }).asPromise();
    const connB = await mongoose.createConnection(mongod.getUri(), { dbName: `dbb${s}` }).asPromise();
    try {
      const IntOrderA = connA.model(`IntOrderA${s}`, new mongoose.Schema({ status: String }, { collection: 'orders_shared' }));
      const IntOrderB = connB.model(`IntOrderB${s}`, new mongoose.Schema({ status: String }, { collection: 'orders_shared' }));

      await IntOrderA.find({ status: 'a' }).exec();
      await IntOrderB.find({ status: 'b' }).exec();
      await a.flush();

      const items = itemsOf(bodies);
      expect(items.map((i) => i.model).sort()).toEqual([IntOrderA.modelName, IntOrderB.modelName].sort());
      expect(items.every((i) => i.collection === 'orders_shared')).toBe(true);
    } finally {
      await connA.close();
      await connB.close();
    }
  });

  it('models defined before connect resolve to their names after connect, discriminators with a custom key included', async () => {
    const s = suffix();
    const { bodies, fetchImpl } = capture();
    // Models and init() before the connection opens: the registry cannot
    // read the db name yet, and must rebuild once it can.
    const conn = mongoose.createConnection();
    const Pre = conn.model(`IntPre${s}`, new mongoose.Schema({ a: String }));
    const Shape = conn.model(`IntShape${s}`, new mongoose.Schema({ name: String }, { discriminatorKey: 'kind' }));
    const Circle = Shape.discriminator(`IntCircle${s}`, new mongoose.Schema({ r: Number }));
    const a = init({ apiKey: 'k', app: 'int-app', thresholdMs: 0, mongoose, fetchImpl });
    // A query on the already-open default connection builds the resolver's
    // index now, while these models' db name is still unreadable — the case
    // the registry must recover from once the connection opens.
    const Probe = mongoose.model(`IntPreProbe${s}`, new mongoose.Schema({ a: String }));
    await Probe.find({ a: 'p' }).exec();
    await conn.openUri(mongod.getUri(), { dbName: `predb${s}` });
    try {
      await Pre.find({ a: 'x' }).exec();
      await Circle.find({ name: 'c' }).exec();
      await Shape.find({ name: 's' }).exec();
      await a.flush();

      const items = itemsOf(bodies);
      const byModel = (m: string) => items.filter((i) => i.model === m);
      expect(byModel(Pre.modelName)).toHaveLength(1);
      expect(byModel(Circle.modelName)).toHaveLength(1);
      expect(byModel(Circle.modelName)[0]!.filterShape).toEqual([{ key: 'kind', op: 'eq' }, { key: 'name', op: 'eq' }]);
      expect(byModel(Shape.modelName)).toHaveLength(1);
      expect(byModel(Probe.modelName)).toHaveLength(1);
      expect(items).toHaveLength(4);
    } finally {
      await conn.close();
    }
  });

  it('a cursor read in batches is one find occurrence, with no getMore item', async () => {
    const Many = mongoose.model(`IntMany${suffix()}`, new mongoose.Schema({ n: Number }));
    await Many.insertMany(Array.from({ length: 300 }, (_, n) => ({ n })));
    const { bodies, fetchImpl } = capture();
    const a = init({ apiKey: 'k', app: 'int-app', thresholdMs: 0, mongoose, fetchImpl });

    const docs = await Many.collection.find({}).batchSize(10).toArray();
    expect(docs).toHaveLength(300);
    await a.flush();

    const items = itemsOf(bodies);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ model: Many.modelName, operation: 'find', count: 1 });
    expect(items.some((i) => i.operation === 'getMore')).toBe(false);
  });

  it('a failed command at the threshold is counted and still rejects in the app', async () => {
    const Uniq = mongoose.model(`IntUniq${suffix()}`, new mongoose.Schema({ email: { type: String, unique: true } }));
    await Uniq.init();
    await Uniq.create({ email: 'dup@x.test' });
    const { bodies, fetchImpl } = capture();
    const a = init({ apiKey: 'k', app: 'int-app', thresholdMs: 0, mongoose, fetchImpl, onError: () => {} });

    await expect(Uniq.collection.insertOne({ email: 'dup@x.test' })).rejects.toMatchObject({ code: 11000 });
    await a.flush();

    const insert = itemsOf(bodies).find((i) => i.model === Uniq.modelName && i.operation === 'insert');
    expect(insert).toBeDefined();
    expect(insert!.count).toBeGreaterThanOrEqual(1);
  });

  it('captures insert, save(), collection bulkWrite statements and Model.collection queries', async () => {
    const Doc = mongoose.model(`IntDoc${suffix()}`, new mongoose.Schema({ a: Number, b: String }));
    const { bodies, fetchImpl } = capture();
    const a = init({ apiKey: 'k', app: 'int-app', thresholdMs: 0, mongoose, fetchImpl });
    const step = async (fn: () => Promise<unknown>) => {
      bodies.length = 0;
      await fn();
      await a.flush();
      return itemsOf(bodies).filter((i) => i.model === Doc.modelName);
    };

    const doc = await Doc.create({ a: 1, b: 'x' });
    await a.flush();
    expect(itemsOf(bodies).map((i) => i.operation)).toEqual(['insert']);

    const saved = await step(async () => { doc.b = 'y'; await doc.save(); });
    expect(saved.map((i) => i.operation)).toEqual(['updateOne']);
    expect(saved[0]!.filterShape).toEqual([{ key: '_id', op: 'eq' }]);

    const bulk = await step(() => Doc.collection.bulkWrite([
      { insertOne: { document: { a: 2 } } },
      { updateOne: { filter: { a: 2 }, update: { $set: { b: 'z' } } } },
      { deleteMany: { filter: { a: { $gt: 100 } } } },
    ]));
    expect(bulk.map((i) => i.operation).sort()).toEqual(['deleteMany', 'insert', 'updateOne']);

    const raw = await step(() => Doc.collection.find({ a: 1 }).toArray());
    expect(raw).toHaveLength(1);
    expect(raw[0]).toMatchObject({ operation: 'find', filterShape: [{ key: 'a', op: 'eq' }] });
  });

  it('never puts a queried value in the payload, for every captured command type', async () => {
    const s = suffix();
    const Vault = mongoose.model(`IntVault${s}`, new mongoose.Schema({ email: String, pin: Number, note: String }));
    const Other = mongoose.model(`IntVaultOther${s}`, new mongoose.Schema({ owner: String, memo: String }));
    const { bodies, fetchImpl } = capture();
    const a = init({ apiKey: 'k', app: 'int-app', thresholdMs: 0, mongoose, fetchImpl });

    const secrets: string[] = [];
    const secret = (label: string) => {
      const v = `zz-${label}-${Math.floor(Math.random() * 1e9)}-secret`;
      secrets.push(v);
      return v;
    };

    await Vault.find({ email: secret('find') }).exec();
    await Vault.findOne({ email: secret('findOne') }).exec();
    await Vault.countDocuments({ email: secret('count') }).exec();
    await Vault.distinct('note', { email: secret('distinct') }).exec();
    await Vault.updateOne({ email: secret('u1f') }, { $set: { note: secret('u1u') } }).exec();
    await Vault.updateMany({ email: secret('umf') }, { $set: { note: secret('umu') } }).exec();
    await Vault.replaceOne({ email: secret('rf') }, { email: secret('rr'), note: secret('rn') }).exec();
    await Vault.deleteOne({ email: secret('d1') }).exec();
    await Vault.deleteMany({ email: secret('dm') }).exec();
    await Vault.findOneAndUpdate({ email: secret('fouf') }, { $set: { note: secret('fouu') } }).exec();
    await Vault.findOneAndDelete({ email: secret('fodf') }).exec();
    await Vault.findOneAndReplace({ email: secret('forf') }, { email: secret('forr') }).exec();
    await Vault.aggregate([
      { $match: { email: secret('aggm') } },
      { $lookup: { from: Other.collection.collectionName, as: 'o', pipeline: [{ $match: { memo: secret('aggl') } }] } },
    ]);
    await Vault.create({ email: secret('ins1'), note: secret('ins1n') });
    await Vault.insertMany([{ email: secret('insm1') }, { email: secret('insm2') }]);
    await Vault.bulkWrite([
      { insertOne: { document: { email: secret('bwi') } } },
      { updateOne: { filter: { email: secret('bwuf') }, update: { $set: { note: secret('bwuu') } } } },
      { deleteMany: { filter: { email: secret('bwd') } } },
    ]);
    await a.flush();

    expect(bodies.length).toBeGreaterThanOrEqual(1);
    const body = bodies.join('');
    for (const v of secrets) expect(body, v).not.toContain(v);
    for (const banned of ['lsid', '$clusterTime', '"$db"', 'firstBatch']) expect(body, banned).not.toContain(banned);
    // Key names stay (the $lookup sub-pipeline's own keys are summarised as
    // "<object>" past redact's depth, exactly as in 0.2).
    for (const key of ['email', 'note', '$match', '$lookup']) expect(body, key).toContain(key);
    for (const b of bodies) expect(() => ingestPayloadSchema.parse(JSON.parse(b))).not.toThrow();

    const ops = new Set(itemsOf(bodies).map((i) => i.operation));
    for (const op of ['find', 'findOne', 'countDocuments', 'distinct', 'updateOne', 'updateMany', 'replaceOne',
      'deleteOne', 'deleteMany', 'findOneAndUpdate', 'findOneAndDelete', 'findOneAndReplace', 'aggregate', 'insert']) {
      expect(ops.has(op), op).toBe(true);
    }
  });
});
