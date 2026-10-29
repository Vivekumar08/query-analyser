import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import { ingestPayloadSchema } from '@query-analyser/contract';
import { init, instrument, shutdown } from '../../sdk/src/index.js';
import { installConnectWrap, MONITORING_OFF_WARNING } from '../../sdk/src/drivers.js';
import { DRIVERS, capture, loadedDriver, startMongo, suffix } from './harness.js';

/**
 * Every `mongodb` driver major (4–7) on a real mongod. Each test calls
 * init() and then installConnectWrap(mod.MongoClient): the aliased driver
 * copy is not the `mongodb` init() resolves, so its prototype is wrapped
 * here exactly as init() wraps the resolved one.
 */
describe.each(DRIVERS)('mongodb $major', ({ major, alias, mod }) => {
  let mongod: MongoMemoryServer;
  let uri: string;
  const clients: InstanceType<typeof mod.MongoClient>[] = [];

  beforeAll(async () => {
    mongod = await startMongo();
    uri = mongod.getUri();
  });
  afterAll(async () => {
    await mongod.stop();
  });
  afterEach(async () => {
    await shutdown();
    await Promise.all(clients.splice(0).map((c) => c.close().catch(() => {})));
  });

  function setup() {
    const cap = capture();
    const onError = vi.fn();
    const a = init({ apiKey: 'k', app: `compat-mongodb${major}`, thresholdMs: 0, fetchImpl: cap.fetchImpl, onError });
    installConnectWrap(mod.MongoClient);
    return { ...cap, onError, a };
  }
  function client(options?: Record<string, unknown>) {
    const c = new mod.MongoClient(uri, options);
    clients.push(c);
    return c;
  }
  const warnings = (onError: ReturnType<typeof vi.fn>) =>
    onError.mock.calls.map(([e]) => (e as Error).message).filter((m) => m === MONITORING_OFF_WARNING);

  it(`loads driver ${major}`, () => {
    expect(loadedDriver(alias, mod)).toEqual({ major, same: true });
  });

  it('captures every command in the table under 0.2-style names', async () => {
    const { a, items } = setup();
    const c = client();
    await c.connect();
    const coll = c.db('compat').collection(`table_${suffix()}`);

    await coll.find({ a: 1 }).toArray();
    await coll.findOne({ a: 1 });
    await coll.aggregate([{ $match: { a: 1 } }]).toArray();
    await coll.countDocuments({ a: 1 });
    await coll.distinct('b', { a: 1 });
    await coll.updateOne({ a: 1 }, { $set: { b: 1 } });
    await coll.updateMany({ a: 1 }, { $set: { b: 2 } });
    await coll.replaceOne({ a: 1 }, { a: 1, b: 3 });
    await coll.deleteOne({ a: 2 });
    await coll.deleteMany({ a: 3 });
    await coll.findOneAndUpdate({ a: 1 }, { $set: { b: 4 } });
    await coll.findOneAndDelete({ a: 4 });
    await coll.findOneAndReplace({ a: 1 }, { a: 1, b: 5 });
    await coll.insertOne({ a: 9 });
    await coll.estimatedDocumentCount();
    await a.flush();

    expect(new Set(items().map((i) => i.operation))).toEqual(new Set(['find', 'findOne', 'aggregate', 'countDocuments', 'distinct',
      'updateOne', 'updateMany', 'replaceOne', 'deleteOne', 'deleteMany', 'findOneAndUpdate', 'findOneAndDelete', 'findOneAndReplace', 'insert', 'count']));
    expect(items().every((i) => i.source === 'mongodb' && i.collection === coll.collectionName)).toBe(true);
  });

  it('zero-setup: an explicit connect() after init() is captured with no options', async () => {
    const { a, items, onError } = setup();
    const c = client();
    await c.connect();
    const name = `zero_${suffix()}`;
    await c.db('compat').collection(name).find({ status: 'x' }).toArray();
    await a.flush();

    expect(items()).toHaveLength(1);
    expect(items()[0]).toMatchObject({
      model: name, collection: name, operation: 'find', source: 'mongodb', count: 1,
      filterShape: [{ key: 'status', op: 'eq' }],
    });
    expect(warnings(onError)).toHaveLength(0);
  });

  it('zero-setup: auto-connect on the first operation is captured too', async () => {
    const { a, items } = setup();
    const c = client(); // never connect()ed: the driver connects on the first operation
    const name = `auto_${suffix()}`;
    await c.db('compat').collection(name).find({ status: 'x' }).toArray();
    await a.flush();

    expect(items()).toHaveLength(1);
    expect(items()[0]).toMatchObject({ model: name, collection: name, operation: 'find', count: 1 });
  });

  it('a client connected before the SDK saw it warns once and captures nothing', async () => {
    const c = client();
    await c.connect();
    const { a, items, onError } = setup();

    instrument(c);
    instrument(c);
    expect(warnings(onError)).toHaveLength(1);

    await c.db('compat').collection(`early_${suffix()}`).find({ a: 1 }).toArray();
    await a.flush();
    expect(items()).toHaveLength(0);
  });

  it('pairs 50 concurrent finds of two shapes correctly', async () => {
    const { a, items } = setup();
    const c = client();
    await c.connect();
    const coll = c.db('compat').collection(`pair_${suffix()}`);
    await coll.insertMany(Array.from({ length: 50 }, (_, n) => ({ a: n, b: n, c: n })));
    await a.flush();

    const before = items().length;
    await Promise.all(Array.from({ length: 50 }, (_, n) =>
      (n % 2 === 0 ? coll.find({ a: n }) : coll.find({ b: n, c: { $gte: n } })).toArray()));
    await a.flush();

    const finds = items().slice(before).filter((i) => i.operation === 'find');
    expect(finds).toHaveLength(2);
    const byShape = new Map(finds.map((i) => [JSON.stringify(i.filterShape), i.count]));
    expect(byShape.get(JSON.stringify([{ key: 'a', op: 'eq' }]))).toBe(25);
    expect(byShape.get(JSON.stringify([{ key: 'b', op: 'eq' }, { key: 'c', op: 'range' }]))).toBe(25);
  });

  it('a cursor read in batches of 10 is one find occurrence', async () => {
    const { a, items } = setup();
    const c = client();
    await c.connect();
    const coll = c.db('compat').collection(`cursor_${suffix()}`);
    await coll.insertMany(Array.from({ length: 300 }, (_, n) => ({ n })));

    const docs = await coll.find({}).batchSize(10).toArray();
    expect(docs).toHaveLength(300);
    await a.flush();

    const finds = items().filter((i) => i.operation === 'find');
    expect(finds).toHaveLength(1);
    expect(finds[0]!.count).toBe(1);
    expect(items().some((i) => i.operation === 'getMore')).toBe(false);
  });

  it('a failed insert is counted and still rejects', async () => {
    const { a, items, bodies } = setup();
    const c = client();
    await c.connect();
    const coll = c.db('compat').collection<{ _id: number }>(`dup_${suffix()}`);
    await coll.insertOne({ _id: 1 });
    await a.flush();
    bodies.length = 0;

    await expect(coll.insertOne({ _id: 1 })).rejects.toMatchObject({ code: 11000 });
    await a.flush();

    const insert = items().find((i) => i.operation === 'insert');
    expect(insert).toBeDefined();
    expect(insert!.count).toBe(1);
  });

  it('never puts a queried value in the payload for any command', async () => {
    const { a, bodies, items } = setup();
    const c = client();
    await c.connect();
    const db = c.db('compat');
    const coll = db.collection(`vault_${suffix()}`);
    const other = db.collection(`vault_other_${suffix()}`);

    const secrets: string[] = [];
    const secret = (label: string) => {
      const v = `zz-${label}-${Math.floor(Math.random() * 1e9)}-secret`;
      secrets.push(v);
      return v;
    };

    await coll.find({ email: secret('find') }).sort({ email: -1 }).toArray();
    await coll.findOne({ email: secret('findOne') });
    await coll.countDocuments({ email: secret('count') });
    await coll.distinct('note', { email: secret('distinct') });
    await coll.updateOne({ email: secret('u1f') }, { $set: { note: secret('u1u') } });
    await coll.updateMany({ email: secret('umf') }, { $set: { note: secret('umu') } });
    await coll.replaceOne({ email: secret('rf') }, { email: secret('rr'), note: secret('rn') });
    await coll.deleteOne({ email: secret('d1') });
    await coll.deleteMany({ email: secret('dm') });
    await coll.findOneAndUpdate({ email: secret('fouf') }, { $set: { note: secret('fouu') } });
    await coll.findOneAndDelete({ email: secret('fodf') });
    await coll.findOneAndReplace({ email: secret('forf') }, { email: secret('forr') });
    await coll.aggregate([
      { $match: { email: secret('aggm') } },
      { $lookup: { from: other.collectionName, as: 'o', pipeline: [{ $match: { memo: secret('aggl') } }] } },
    ]).toArray();
    await coll.insertOne({ email: secret('ins1'), note: secret('ins1n') });
    await coll.insertMany([{ email: secret('insm1') }, { email: secret('insm2') }]);
    await coll.bulkWrite([
      { insertOne: { document: { email: secret('bwi') } } },
      { updateOne: { filter: { email: secret('bwuf') }, update: { $set: { note: secret('bwuu') } } } },
      { deleteMany: { filter: { email: secret('bwd') } } },
    ]);
    await a.flush();

    expect(bodies.length).toBeGreaterThanOrEqual(1);
    const body = bodies.join('');
    for (const v of secrets) expect(body, v).not.toContain(v);
    for (const banned of ['lsid', '$clusterTime', '"$db"', 'firstBatch']) expect(body, banned).not.toContain(banned);
    for (const key of ['email', 'note', '$match', '$lookup']) expect(body, key).toContain(key);
    for (const b of bodies) expect(() => ingestPayloadSchema.parse(JSON.parse(b))).not.toThrow();
    // insert has no sample: it goes out as null.
    const inserts = items().filter((i) => i.operation === 'insert');
    expect(inserts.length).toBeGreaterThanOrEqual(1);
    expect(inserts.every((i) => i.sample === null)).toBe(true);
  });

  describe.runIf(major >= 6)('MongoClient.bulkWrite (mongod 8.0.4)', () => {
    let mongod8: MongoMemoryServer;
    beforeAll(async () => {
      mongod8 = await startMongo('8.0.4');
    });
    afterAll(async () => {
      await mongod8.stop();
    });

    it('is captured per statement despite running on the admin db', async () => {
      const { a, items } = setup();
      const c = new mod.MongoClient(mongod8.getUri());
      clients.push(c);
      await c.connect();
      const namespace = 'compat.orders';
      await c.bulkWrite([
        { name: 'insertOne', namespace, document: { status: 'new', total: 1 } },
        { name: 'updateMany', namespace, filter: { status: 'new' }, update: { $set: { total: 2 } } },
        { name: 'deleteOne', namespace, filter: { status: 'gone' } },
      ]);
      await a.flush();

      const ops = items().filter((i) => i.collection === 'orders');
      expect(ops.map((i) => i.operation).sort()).toEqual(['deleteOne', 'insert', 'updateMany']);
      expect(ops.every((i) => i.model === 'orders' && i.source === 'mongodb')).toBe(true);
    });
  });
});
