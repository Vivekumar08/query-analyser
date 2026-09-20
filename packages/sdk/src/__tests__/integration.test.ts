import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { init, shutdown } from '../index.js';

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
    bodies.push(typeof init?.body === 'string' ? init.body : String(init?.body));
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
