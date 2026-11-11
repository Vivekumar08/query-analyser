import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import { ingestPayloadSchema } from '@query-analyser/contract';
import { init, shutdown } from '../../sdk/src/index.js';
import { MONGOOSES, bundledDriver, capture, startMongo, suffix } from './harness.js';

/**
 * Every Mongoose major (6–9) on a real mongod, each on the driver it
 * bundles. Each test calls init({ mongoose: mod }) before mod.connect(uri),
 * the zero-setup path: the SDK wraps mod.mongo.MongoClient's connect.
 */

let mongod: MongoMemoryServer;
let uri: string;

beforeAll(async () => {
  mongod = await startMongo();
  uri = mongod.getUri();
});
afterAll(async () => {
  await mongod.stop();
});

describe.each(MONGOOSES)('mongoose $major', ({ major, alias, mod }) => {
  afterEach(async () => {
    await mod.disconnect();
    await shutdown();
  });

  async function setup(options: { onError?: (e: Error) => void } = {}) {
    const cap = capture();
    const a = init({
      apiKey: 'k', app: `compat-mongoose${major}`, mongoose: mod, thresholdMs: 0, fetchImpl: cap.fetchImpl,
      onError: options.onError ?? (() => {}),
    });
    await mod.connect(uri, { dbName: `compat_m${major}` });
    return { ...cap, a };
  }

  it(`loads mongoose ${major} on the driver it bundles (${major - 2})`, () => {
    expect(mod.version.startsWith(`${major}.`), mod.version).toBe(true);
    expect(bundledDriver(alias, mod)).toEqual({ major: major - 2, same: true });
  });

  it('zero-setup: init() before connect() captures Model queries under the model name', async () => {
    const { a, items } = await setup();
    const User = mod.model(`User${suffix()}`, new mod.Schema({ email: String }));
    await User.find({ email: 'x' }).exec();
    await a.flush();

    expect(items()).toHaveLength(1);
    expect(items()[0]).toMatchObject({
      model: User.modelName, collection: User.collection.collectionName, operation: 'find', source: 'mongodb', count: 1,
      filterShape: [{ key: 'email', op: 'eq' }],
    });
  });

  it('a connection created later with createConnection() is captured', async () => {
    const { a, items } = await setup();
    const conn = await mod.createConnection(uri, { dbName: `compat_late${major}` }).asPromise();
    const Event = conn.model(`Event${suffix()}`, new mod.Schema({ kind: String }));
    await Event.find({ kind: 'x' }).exec();
    await a.flush();

    expect(items()).toHaveLength(1);
    expect(items()[0]).toMatchObject({ model: Event.modelName, collection: Event.collection.collectionName, operation: 'find' });
  });

  it('useDb() models resolve to their own model name', async () => {
    const { a, items } = await setup();
    const s = suffix();
    // The parent is its own connection, not mod.connection: on Mongoose 6
    // and 7 (no SDK involved), disconnect() after a useDb() leaves the
    // parent force-closed, and a reconnected default connection would then
    // reject every later query with "Connection was force closed".
    const parent = await mod.createConnection(uri, { dbName: `compat_main${major}` }).asPromise();
    const Main = parent.model(`Main${s}`, new mod.Schema({ a: String }, { collection: `shared_${s}` }));
    const tenant = parent.useDb(`compat_tenant${major}`);
    const Tenant = tenant.model(`Tenant${s}`, new mod.Schema({ a: String }, { collection: `shared_${s}` }));
    await Main.find({ a: 'x' }).exec();
    await Tenant.find({ a: 'y' }).exec();
    await a.flush();

    expect(items().map((i) => i.model).sort()).toEqual([Main.modelName, Tenant.modelName].sort());
    expect(items().every((i) => i.collection === `shared_${s}`)).toBe(true);
  });

  it('a discriminator query resolves to the discriminator, keeping __t in the shape', async () => {
    const { a, items } = await setup();
    const s = suffix();
    const Animal = mod.model(`Animal${s}`, new mod.Schema({ name: String }));
    const Dog = Animal.discriminator(`Dog${s}`, new mod.Schema({ breed: String }));
    await Dog.find({ name: 'rex' }).exec();
    await a.flush();

    expect(items()).toHaveLength(1);
    expect(items()[0]!.model).toBe(Dog.modelName);
    expect(items()[0]!.collection).toBe(Animal.collection.collectionName);
    expect(items()[0]!.filterShape).toContainEqual({ key: '__t', op: 'eq' });
  });

  it('a cursor read in batches is one occurrence', async () => {
    const { a, items, bodies } = await setup();
    const Many = mod.model(`Many${suffix()}`, new mod.Schema({ n: Number }));
    await Many.insertMany(Array.from({ length: 300 }, (_, n) => ({ n })));
    await a.flush();
    bodies.length = 0;

    const docs = await Many.find({}).batchSize(10).exec();
    expect(docs).toHaveLength(300);
    await a.flush();

    expect(items()).toHaveLength(1);
    expect(items()[0]).toMatchObject({ model: Many.modelName, operation: 'find', count: 1 });
  });

  it('a failed command is counted and still rejects in the app', async () => {
    const { a, items, bodies } = await setup();
    const Uniq = mod.model(`Uniq${suffix()}`, new mod.Schema({ email: { type: String, unique: true } }));
    await Uniq.init();
    await Uniq.create({ email: 'dup@x.test' });
    await a.flush();
    bodies.length = 0;

    await expect(Uniq.create({ email: 'dup@x.test' })).rejects.toMatchObject({ code: 11000 });
    await a.flush();

    const insert = items().find((i) => i.model === Uniq.modelName && i.operation === 'insert');
    expect(insert).toBeDefined();
    expect(insert!.count).toBe(1);
  });

  it('never puts a queried value in the payload', async () => {
    const { a, bodies, items } = await setup();
    const s = suffix();
    const Vault = mod.model(`Vault${s}`, new mod.Schema({ email: String, pin: Number, note: String }));
    const Other = mod.model(`VaultOther${s}`, new mod.Schema({ owner: String, memo: String }));

    const secrets: string[] = [];
    const secret = (label: string) => {
      const v = `zz-${label}-${Math.floor(Math.random() * 1e9)}-secret`;
      secrets.push(v);
      return v;
    };

    await Vault.find({ email: secret('find') }).sort({ note: -1 }).exec();
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
    for (const key of ['email', 'note', '$match', '$lookup']) expect(body, key).toContain(key);
    for (const b of bodies) expect(() => ingestPayloadSchema.parse(JSON.parse(b))).not.toThrow();

    const ops = new Set(items().map((i) => i.operation));
    for (const op of ['find', 'findOne', 'countDocuments', 'distinct', 'updateOne', 'updateMany', 'replaceOne',
      'deleteOne', 'deleteMany', 'findOneAndUpdate', 'findOneAndDelete', 'findOneAndReplace', 'aggregate', 'insert']) {
      expect(ops.has(op), op).toBe(true);
    }
  });

  it('save, find, update, delete, aggregate, insertMany and bulkWrite never throw into app code', async () => {
    const errors: Error[] = [];
    const { a, items } = await setup({ onError: (e) => { errors.push(e); } });
    const Thing = mod.model(`Thing${suffix()}`, new mod.Schema({ a: Number, b: String }));

    const doc = new Thing({ a: 1, b: 'x' });
    await expect(doc.save()).resolves.toBeDefined();
    await expect(Thing.find({ a: 1 }).exec()).resolves.toHaveLength(1);
    await expect(Thing.updateOne({ a: 1 }, { $set: { b: 'y' } }).exec()).resolves.toBeDefined();
    await expect(Thing.deleteOne({ a: 2 }).exec()).resolves.toBeDefined();
    await expect(Thing.aggregate([{ $match: { a: 1 } }])).resolves.toHaveLength(1);
    await expect(Thing.insertMany([{ a: 3 }, { a: 4 }])).resolves.toHaveLength(2);
    await expect(Thing.bulkWrite([
      { insertOne: { document: { a: 5 } } },
      { updateOne: { filter: { a: 5 }, update: { $set: { b: 'z' } } } },
      { deleteOne: { filter: { a: 4 } } },
    ])).resolves.toBeDefined();
    await a.flush();

    expect(errors).toEqual([]);
    expect(new Set(items().map((i) => i.operation))).toEqual(new Set(['insert', 'find', 'updateOne', 'deleteOne', 'aggregate']));
  });
});

describe('mongoose 9', () => {
  const mod = MONGOOSES.find((m) => m.major === 9)!.mod;
  afterEach(async () => {
    await mod.disconnect();
    await shutdown();
  });

  it('never throws into app code where 0.2 threw "next is not a function"', async () => {
    const { fetchImpl, items } = capture();
    const errors: Error[] = [];
    const a = init({ apiKey: 'k', app: 'compat-mongoose9-hooks', mongoose: mod, thresholdMs: 0, fetchImpl, onError: (e) => { errors.push(e); } });
    await mod.connect(uri, { dbName: 'compat_m9_hooks' });

    const schema = new mod.Schema({ a: Number, b: String });
    schema.pre('save', async function () {});
    schema.pre('find', function () {});
    const Hooked = mod.model(`Hooked${suffix()}`, schema);

    await expect(new Hooked({ a: 1, b: 'x' }).save()).resolves.toBeDefined();
    await expect(Hooked.find({ a: 1 }).exec()).resolves.toHaveLength(1);
    await expect(Hooked.findOne({ a: 1 }).exec()).resolves.toBeTruthy();
    await expect(Hooked.updateOne({ a: 1 }, { $set: { b: 'y' } }).exec()).resolves.toBeDefined();
    await expect(Hooked.deleteOne({ a: 2 }).exec()).resolves.toBeDefined();
    await expect(Hooked.aggregate([{ $match: { a: 1 } }])).resolves.toHaveLength(1);
    await expect(Hooked.countDocuments({ a: 1 }).exec()).resolves.toBe(1);
    await expect(Hooked.insertMany([{ a: 2 }, { a: 3 }])).resolves.toHaveLength(2);
    await a.flush();

    expect(errors).toEqual([]);
    const ops = items().map((i) => i.operation);
    expect(ops).toContain('find');
    expect(ops).toContain('insert');
  });
});
