import { EventEmitter } from 'node:events';
import { describe, it, expect, vi, afterEach, beforeEach, type Mock } from 'vitest';
import { ingestPayloadSchema } from '@query-analyser/contract';
import { Aggregator } from './aggregator.js';
import { buildSignature } from './signature.js';
import {
  attachClient,
  clientStats,
  currentSink,
  setSink,
  toDurationMs,
  MAX_CURSORS,
  MAX_CURSOR_IDLE_MS,
  MAX_IN_FLIGHT,
  MAX_IN_FLIGHT_AGE_MS,
  MONITORING_OFF_WARNING,
  MONITORING_PROBE_CYCLES,
  type MonitorSink,
} from './monitor.js';

class FakeClient extends EventEmitter { options = { monitorCommands: true }; }
let rid = 0;
function run(c: FakeClient, commandName: string, command: object,
  { db = 'app', duration = 150, reply = { ok: 1 } as object, fail = false, connectionId = 1 as unknown, endConnectionId = connectionId as unknown } = {}) {
  const requestId = ++rid;
  c.emit('commandStarted', { requestId, connectionId, databaseName: db, commandName, command });
  c.emit(fail ? 'commandFailed' : 'commandSucceeded',
    { requestId, connectionId: endConnectionId, duration, commandName, ...(fail ? { failure: new Error('x') } : { reply }) });
  return requestId;
}
const sink = (over: Partial<MonitorSink> = {}): MonitorSink => ({ aggregator: new Aggregator(100), thresholdMs: 100,
  onError: vi.fn(), isDisabled: () => false, captureRawSample: () => false, resolveModel: (_d, coll) => coll, ...over });
afterEach(() => { setSink(null); vi.useRealTimers(); vi.restoreAllMocks(); });

const liveReply = (id: string) => ({ cursor: { id: { toString: () => id }, firstBatch: [] } });

describe('constants and helpers', () => {
  it('exports the bounds verbatim', () => {
    expect(MAX_IN_FLIGHT).toBe(2_000);
    expect(MAX_IN_FLIGHT_AGE_MS).toBe(600_000);
    expect(MAX_CURSORS).toBe(2_000);
    expect(MAX_CURSOR_IDLE_MS).toBe(600_000);
  });

  it('toDurationMs rounds a finite non-negative number and rejects anything else', () => {
    expect(toDurationMs(150.6)).toBe(151);
    expect(toDurationMs(0)).toBe(0);
    expect(toDurationMs(-1)).toBeNull();
    expect(toDurationMs(Number.NaN)).toBeNull();
    expect(toDurationMs(Number.POSITIVE_INFINITY)).toBeNull();
    expect(toDurationMs('150')).toBeNull();
    expect(toDurationMs(undefined)).toBeNull();
  });

  it('setSink and currentSink round-trip', () => {
    const s = sink();
    setSink(s);
    expect(currentSink()).toBe(s);
    setSink(null);
    expect(currentSink()).toBeNull();
  });

  it('clientStats is null for a client never attached', () => {
    expect(clientStats(new FakeClient())).toBeNull();
  });
});

describe('monitor', () => {
  let c: FakeClient;
  let s: MonitorSink;
  beforeEach(() => {
    c = new FakeClient();
    s = sink();
    setSink(s);
  });

  it('a failed attach can be retried and leaves no duplicate listeners', () => {
    const e = new FakeClient();
    const realOn = e.on.bind(e);
    let calls = 0;
    e.on = ((event: string, fn: (...a: unknown[]) => void) => {
      calls++;
      if (calls === 2) throw new Error('on-boom');
      return realOn(event, fn);
    }) as typeof e.on;
    expect(attachClient(e)).toBe(false);
    expect(clientStats(e)).toBeNull();
    expect(attachClient(e)).toBe(true);
    expect(e.listenerCount('commandStarted')).toBe(1);
    expect(e.listenerCount('commandSucceeded')).toBe(1);
    expect(e.listenerCount('commandFailed')).toBe(1);
    expect(attachClient(e)).toBe(false);
  });

  it('attaches once per client', () => {
    expect(attachClient(c)).toBe(true);
    expect(attachClient(c)).toBe(false);
    expect(c.listenerCount('commandStarted')).toBe(1);
    expect(c.listenerCount('commandSucceeded')).toBe(1);
    expect(c.listenerCount('commandFailed')).toBe(1);
  });

  describe('attached', () => {
    beforeEach(() => { attachClient(c); });

    it('pairs a start with its success by requestId and records the mapped find', () => {
      run(c, 'find', { find: 'orders', filter: { s: 'x' } });
      expect(s.aggregator.swap().items[0]).toMatchObject({ model: 'orders', operation: 'find', collection: 'orders', count: 1, maxMs: 150 });
      expect(clientStats(c)).toEqual({ inFlight: 0, cursors: 0 });
    });

    it('pairs concurrent starts with their own ends', () => {
      c.emit('commandStarted', { requestId: 501, connectionId: 1, databaseName: 'app', commandName: 'find', command: { find: 'a', filter: {} } });
      c.emit('commandStarted', { requestId: 502, connectionId: 2, databaseName: 'app', commandName: 'find', command: { find: 'b', filter: {} } });
      expect(clientStats(c)!.inFlight).toBe(2);
      c.emit('commandSucceeded', { requestId: 502, connectionId: 2, duration: 300, commandName: 'find', reply: { ok: 1 } });
      c.emit('commandSucceeded', { requestId: 501, connectionId: 1, duration: 120, commandName: 'find', reply: { ok: 1 } });
      const items = s.aggregator.swap().items;
      expect(items.find((i) => i.collection === 'a')).toMatchObject({ count: 1, maxMs: 120 });
      expect(items.find((i) => i.collection === 'b')).toMatchObject({ count: 1, maxMs: 300 });
    });

    it('keys requestIds per client: the same id on two clients never cross-pairs', () => {
      const c2 = new FakeClient();
      attachClient(c2);
      c.emit('commandStarted', { requestId: 7, connectionId: 1, databaseName: 'app', commandName: 'find', command: { find: 'a', filter: {} } });
      c2.emit('commandStarted', { requestId: 7, connectionId: 1, databaseName: 'app', commandName: 'find', command: { find: 'b', filter: {} } });
      c2.emit('commandSucceeded', { requestId: 7, connectionId: 1, duration: 150, commandName: 'find', reply: { ok: 1 } });
      c.emit('commandSucceeded', { requestId: 7, connectionId: 1, duration: 150, commandName: 'find', reply: { ok: 1 } });
      const items = s.aggregator.swap().items;
      expect(items).toHaveLength(2);
      expect(items.map((i) => i.collection).sort()).toEqual(['a', 'b']);
      for (const i of items) expect(i.count).toBe(1);
    });

    it('skips a command under the threshold and counts one at exactly the threshold', () => {
      run(c, 'find', { find: 'o', filter: {} }, { duration: 99 });
      run(c, 'find', { find: 'o', filter: {} }, { duration: 100 });
      const items = s.aggregator.swap().items;
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({ count: 1, maxMs: 100 });
    });

    it('rounds a fractional duration to an integer millisecond', () => {
      run(c, 'find', { find: 'o', filter: {} }, { duration: 150.6 });
      expect(s.aggregator.swap().items[0]!.maxMs).toBe(151);
    });

    it('ignores an end whose duration is not a finite non-negative number', () => {
      run(c, 'find', { find: 'o', filter: {} }, { duration: Number.NaN });
      expect(s.aggregator.swap().items).toHaveLength(0);
      expect(clientStats(c)!.inFlight).toBe(0);
    });

    it('records a failed command at or over the threshold in the same signature', () => {
      run(c, 'find', { find: 'o', filter: { a: 1 } });
      run(c, 'find', { find: 'o', filter: { a: 2 } }, { fail: true, duration: 200 });
      const items = s.aggregator.swap().items;
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({ count: 2, maxMs: 200 });
    });

    it('drops a pair whose connectionId disagrees', () => {
      run(c, 'find', { find: 'o', filter: {} }, { endConnectionId: 2 });
      expect(s.aggregator.swap().items).toHaveLength(0);
      expect(clientStats(c)!.inFlight).toBe(0);
    });

    it('compares connectionIds as strings', () => {
      c.emit('commandStarted', { requestId: 900, connectionId: 1, databaseName: 'app', commandName: 'find', command: { find: 'o', filter: {} } });
      c.emit('commandSucceeded', { requestId: 900, connectionId: '1', duration: 150, commandName: 'find', reply: { ok: 1 } });
      expect(s.aggregator.swap().items).toHaveLength(1);
    });

    it('ignores an end with no matching start', () => {
      c.emit('commandSucceeded', { requestId: 12345, connectionId: 1, duration: 150, commandName: 'find', reply: { ok: 1 } });
      expect(s.aggregator.swap().items).toHaveLength(0);
      expect(s.onError).not.toHaveBeenCalled();
    });

    it('ignores commands outside the allow-list and on admin, local and config, but not bulkWrite', () => {
      run(c, 'hello', { hello: 1 });
      run(c, 'ping', { ping: 1 });
      run(c, 'find', { find: 'o', filter: {} }, { db: 'admin' });
      run(c, 'find', { find: 'o', filter: {} }, { db: 'local' });
      run(c, 'find', { find: 'o', filter: {} }, { db: 'config' });
      expect(clientStats(c)!.inFlight).toBe(0);
      expect(s.aggregator.swap().items).toHaveLength(0);
      run(c, 'bulkWrite', { bulkWrite: 1, ops: [{ insert: 0, document: { a: 1 } }], nsInfo: [{ ns: 'shop.orders' }] }, { db: 'admin' });
      const items = s.aggregator.swap().items;
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({ collection: 'orders', model: 'orders', operation: 'insert' });
    });

    it('records an insert by collection only', () => {
      run(c, 'insert', { insert: 'orders', documents: [{ secret: 'x' }] });
      const items = s.aggregator.swap().items;
      expect(items[0]).toMatchObject({ signature: 'orders.insert()', collection: 'orders', sample: null });
    });

    it('counts each distinct statement shape once per multi-statement event', () => {
      run(c, 'update', { update: 'o', updates: [
        { q: { a: 1 }, u: { $set: { b: 1 } } },
        { q: { a: 2 }, u: { $set: { b: 2 } } },
        { q: { c: 1 }, u: { $set: { b: 3 } } },
      ] });
      const items = s.aggregator.swap().items;
      expect(items).toHaveLength(2);
      for (const i of items) expect(i).toMatchObject({ count: 1, maxMs: 150 });
    });

    it('passes database, collection and filter to resolveModel', () => {
      const resolveModel = vi.fn(() => 'Order');
      setSink(sink({ resolveModel, aggregator: s.aggregator }));
      run(c, 'find', { find: 'orders', filter: { a: 1 } }, { db: 'shop' });
      expect(resolveModel).toHaveBeenCalledWith('shop', 'orders', { a: 1 });
      expect(s.aggregator.swap().items[0]).toMatchObject({ model: 'Order', collection: 'orders' });
    });

    it('adds a matched getMore to the counted find without a second occurrence', () => {
      run(c, 'find', { find: 'd', filter: {} }, { duration: 150, reply: { cursor: { id: { toString: () => '77' }, firstBatch: [] } } });
      expect(clientStats(c)!.cursors).toBe(1);
      run(c, 'getMore', { getMore: { toString: () => '77' }, collection: 'd' }, { duration: 200, reply: { cursor: { id: 0 } } });
      expect(s.aggregator.swap().items[0]).toMatchObject({ count: 1, totalMs: 350, maxMs: 350 });
      expect(clientStats(c)!.cursors).toBe(0);
    });

    it('keeps the cursor while getMore replies a non-zero id', () => {
      run(c, 'find', { find: 'd', filter: {} }, { reply: liveReply('77') });
      run(c, 'getMore', { getMore: { toString: () => '77' }, collection: 'd' }, { duration: 10, reply: liveReply('77') });
      expect(clientStats(c)!.cursors).toBe(1);
      run(c, 'getMore', { getMore: { toString: () => '77' }, collection: 'd' }, { duration: 10, reply: { cursor: { id: 0 } } });
      expect(clientStats(c)!.cursors).toBe(0);
      expect(s.aggregator.swap().items[0]).toMatchObject({ count: 1, totalMs: 170, maxMs: 170 });
    });

    it('counts a slow getMore on its own under the originating signature when the find was fast', () => {
      run(c, 'find', { find: 'd', filter: { a: 1 } }, { duration: 10, reply: liveReply('88') });
      expect(s.aggregator.swap().items).toHaveLength(0);
      run(c, 'getMore', { getMore: { toString: () => '88' }, collection: 'd' }, { duration: 150, reply: { cursor: { id: 0 } } });
      const items = s.aggregator.swap().items;
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({ count: 1, maxMs: 150, operation: 'find', collection: 'd' });
    });

    it('extends the getMore-started occurrence with later getMores', () => {
      run(c, 'find', { find: 'd', filter: {} }, { duration: 10, reply: liveReply('89') });
      run(c, 'getMore', { getMore: { toString: () => '89' }, collection: 'd' }, { duration: 150, reply: liveReply('89') });
      run(c, 'getMore', { getMore: { toString: () => '89' }, collection: 'd' }, { duration: 20, reply: { cursor: { id: 0 } } });
      expect(s.aggregator.swap().items[0]).toMatchObject({ count: 1, totalMs: 170, maxMs: 170 });
    });

    it('starts a new occurrence for a getMore after a flush', () => {
      run(c, 'find', { find: 'd', filter: {} }, { duration: 150, reply: liveReply('90') });
      expect(s.aggregator.swap().items[0]).toMatchObject({ count: 1, maxMs: 150 });
      run(c, 'getMore', { getMore: { toString: () => '90' }, collection: 'd' }, { duration: 150, reply: { cursor: { id: 0 } } });
      expect(s.aggregator.swap().items[0]).toMatchObject({ count: 1, maxMs: 150, totalMs: 150 });
    });

    it('a slow failed getMore still extends its occurrence and then forgets its cursor', () => {
      run(c, 'find', { find: 'd', filter: {} }, { duration: 150, reply: liveReply('96') });
      run(c, 'getMore', { getMore: { toString: () => '96' }, collection: 'd' }, { fail: true, duration: 200 });
      expect(clientStats(c)!.cursors).toBe(0);
      expect(s.aggregator.swap().items[0]).toMatchObject({ count: 1, totalMs: 350, maxMs: 350 });
    });

    it('evicts a stale start with no sink: a later start drops it after 600 s', () => {
      vi.useFakeTimers();
      c.emit('commandStarted', { requestId: 4242, connectionId: 1, databaseName: 'app', commandName: 'find', command: { find: 'o', filter: {}, lsid: { id: 'secret' } } });
      run(c, 'find', { find: 'd', filter: {} }, { duration: 5, reply: liveReply('97') });
      expect(clientStats(c)).toEqual({ inFlight: 1, cursors: 1 });
      setSink(null);
      vi.advanceTimersByTime(MAX_IN_FLIGHT_AGE_MS + 1);
      c.emit('commandStarted', { requestId: 4243, connectionId: 1, databaseName: 'app', commandName: 'find', command: { find: 'o', filter: {} } });
      expect(clientStats(c)).toEqual({ inFlight: 0, cursors: 0 });
    });

    it('evicts a stale start while disabled: a later end drops it after 600 s', () => {
      vi.useFakeTimers();
      c.emit('commandStarted', { requestId: 4244, connectionId: 1, databaseName: 'app', commandName: 'find', command: { find: 'o', filter: {} } });
      run(c, 'find', { find: 'd', filter: {} }, { duration: 5, reply: liveReply('98') });
      setSink(sink({ isDisabled: () => true }));
      vi.advanceTimersByTime(MAX_IN_FLIGHT_AGE_MS + 1);
      c.emit('commandSucceeded', { requestId: 99_999, connectionId: 1, duration: 1, commandName: 'find', reply: { ok: 1 } });
      expect(clientStats(c)).toEqual({ inFlight: 0, cursors: 0 });
    });

    it('forgets a cursor when its getMore fails', () => {
      run(c, 'find', { find: 'd', filter: {} }, { reply: liveReply('91') });
      run(c, 'getMore', { getMore: { toString: () => '91' }, collection: 'd' }, { fail: true, duration: 5 });
      expect(clientStats(c)!.cursors).toBe(0);
    });

    it('ignores a getMore for an unknown cursor', () => {
      run(c, 'getMore', { getMore: { toString: () => '404' }, collection: 'd' }, { duration: 500, reply: { cursor: { id: 0 } } });
      expect(s.aggregator.swap().items).toHaveLength(0);
      expect(clientStats(c)).toEqual({ inFlight: 0, cursors: 0 });
    });

    it('does not keep a cursor for an exhausted find or a multi-statement command', () => {
      run(c, 'find', { find: 'd', filter: {} }, { reply: { cursor: { id: 0, firstBatch: [] } } });
      run(c, 'find', { find: 'd', filter: {} }, { reply: { ok: 1 } });
      run(c, 'find', { find: 'd', filter: {} }, { fail: true });
      expect(clientStats(c)!.cursors).toBe(0);
    });

    it('does not keep a cursor for a database-level aggregate', () => {
      run(c, 'aggregate', { aggregate: 1, pipeline: [{ $documents: [{ a: 1 }] }] }, { duration: 5, reply: liveReply('95') });
      expect(clientStats(c)!.cursors).toBe(0);
    });

    it('skips a slow database-level aggregate (no collection), so a mixed batch still validates', () => {
      run(c, 'aggregate', { aggregate: 1, pipeline: [{ $changeStream: {} }] }, { duration: 500, reply: { cursor: { id: 0, firstBatch: [] } } });
      run(c, 'aggregate', { aggregate: 1, pipeline: [{ $documents: [{ a: 1 }] }] }, { duration: 500, reply: liveReply('96') });
      run(c, 'find', { find: 'orders', filter: { s: 'x' } });
      run(c, 'aggregate', { aggregate: 'orders', pipeline: [{ $match: { a: 1 } }] }, { reply: { cursor: { id: 0, firstBatch: [] } } });
      const items = s.aggregator.swap().items;
      expect(items.map((i) => i.collection).sort()).toEqual(['orders', 'orders']);
      expect(clientStats(c)).toEqual({ inFlight: 0, cursors: 0 });
      const wire = items.map((item) => ({
        signature: item.signature, hash: item.hash, model: item.model, operation: item.operation,
        filterShape: item.filterShape, sortKeys: item.sortKeys, stages: item.stages,
        count: item.count, totalMs: item.totalMs, maxMs: item.maxMs, lastMs: item.lastMs,
        lastTs: item.lastTs, hist: item.hist, sample: item.sample,
        source: 'mongodb', collection: item.collection,
      }));
      const result = ingestPayloadSchema.safeParse({
        app: 'a', env: 'e', host: 'h', sdkVersion: '0.3.0', bucket: '2026102814',
        thresholdMs: 100, dropped: 0, items: wire,
      });
      expect(result.success).toBe(true);
    });

    it('resolves an aggregate\'s model from its first $match (discriminators), keeping the 0.2 signature', () => {
      const resolveModel = vi.fn((_d: string, coll: string, filter: unknown) =>
        (filter as { __t?: unknown } | undefined)?.__t === 'Dog' ? 'Dog' : coll);
      setSink(sink({ resolveModel, aggregator: s.aggregator }));
      const pipeline = [{ $match: { name: 'rex', __t: 'Dog' } }];
      run(c, 'aggregate', { aggregate: 'animals', pipeline }, { reply: { cursor: { id: 0, firstBatch: [] } } });
      expect(resolveModel).toHaveBeenCalledWith('app', 'animals', { name: 'rex', __t: 'Dog' });
      const item = s.aggregator.swap().items[0]!;
      const expected = buildSignature({ model: 'Dog', operation: 'aggregate', pipeline });
      expect(item).toMatchObject({ model: 'Dog', operation: 'aggregate', hash: expected.hash, signature: expected.signature,
        sample: { pipeline: [{ $match: { name: '<string>', __t: '<string>' } }] } });
    });

    it('keeps a cursor for a live aggregate', () => {
      run(c, 'aggregate', { aggregate: 'd', pipeline: [{ $match: { a: 1 } }] }, { duration: 5, reply: liveReply('92') });
      expect(clientStats(c)!.cursors).toBe(1);
    });

    it('forgets a cursor on killCursors', () => {
      run(c, 'find', { find: 'd', filter: {} }, { reply: liveReply('93') });
      expect(clientStats(c)!.cursors).toBe(1);
      run(c, 'killCursors', { killCursors: 'd', cursors: [{ toString: () => '93' }] }, { duration: 1 });
      expect(clientStats(c)).toEqual({ inFlight: 0, cursors: 0 });
    });

    it('only forgets the cursor whose database matches on killCursors', () => {
      run(c, 'find', { find: 'd', filter: {} }, { db: 'app', reply: liveReply('94') });
      run(c, 'killCursors', { killCursors: 'd', cursors: [{ toString: () => '94' }] }, { db: 'other', duration: 1 });
      expect(clientStats(c)!.cursors).toBe(1);
    });

    it('bounds the in-flight map at 2000 entries and 10 minutes', () => {
      vi.useFakeTimers();
      for (let i = 0; i < MAX_IN_FLIGHT + 1; i++) c.emit('commandStarted', { requestId: 10_000 + i, connectionId: 1, databaseName: 'app', commandName: 'find', command: { find: 'x', filter: {} } });
      expect(clientStats(c)!.inFlight).toBe(MAX_IN_FLIGHT);
      // the oldest (10_000) was evicted: its end pairs with nothing
      c.emit('commandSucceeded', { requestId: 10_000, connectionId: 1, duration: 150, commandName: 'find', reply: { ok: 1 } });
      expect(s.aggregator.swap().items).toHaveLength(0);
      vi.advanceTimersByTime(MAX_IN_FLIGHT_AGE_MS + 1);
      c.emit('commandStarted', { requestId: 1, connectionId: 1, databaseName: 'app', commandName: 'find', command: { find: 'x', filter: {} } });
      expect(clientStats(c)!.inFlight).toBe(1);
    });

    it('bounds the cursor map at 2000 entries and 10 minutes idle', () => {
      vi.useFakeTimers();
      for (let i = 0; i < MAX_CURSORS + 1; i++) run(c, 'find', { find: 'x', filter: {} }, { duration: 5, reply: liveReply(String(1_000 + i)) });
      expect(clientStats(c)!.cursors).toBe(MAX_CURSORS);
      // the oldest cursor (1000) was evicted: its getMore finds nothing
      run(c, 'getMore', { getMore: { toString: () => '1000' }, collection: 'x' }, { duration: 500, reply: { cursor: { id: 0 } } });
      expect(s.aggregator.swap().items).toHaveLength(0);
      vi.advanceTimersByTime(MAX_CURSOR_IDLE_MS + 1);
      run(c, 'find', { find: 'x', filter: {} }, { duration: 5, reply: liveReply('99999') });
      expect(clientStats(c)!.cursors).toBe(1);
    });

    it('a getMore touches its cursor so idle eviction spares it', () => {
      vi.useFakeTimers();
      run(c, 'find', { find: 'x', filter: {} }, { duration: 5, reply: liveReply('1') });
      run(c, 'find', { find: 'x', filter: {} }, { duration: 5, reply: liveReply('2') });
      vi.advanceTimersByTime(MAX_CURSOR_IDLE_MS - 1000);
      run(c, 'getMore', { getMore: { toString: () => '1' }, collection: 'x' }, { duration: 5, reply: liveReply('1') });
      vi.advanceTimersByTime(2000);
      run(c, 'find', { find: 'x', filter: {} }, { duration: 5, reply: liveReply('3') });
      expect(clientStats(c)!.cursors).toBe(2); // 1 (touched) and 3; 2 evicted
      run(c, 'getMore', { getMore: { toString: () => '2' }, collection: 'x' }, { duration: 500, reply: { cursor: { id: 0 } } });
      expect(s.aggregator.swap().items).toHaveLength(0);
    });

    it('never lets an internal failure escape into the driver', () => {
      vi.spyOn(s.aggregator, 'add').mockImplementation(() => { throw new Error('boom'); });
      expect(() => run(c, 'find', { find: 'o', filter: {} })).not.toThrow();
      expect((s.onError as Mock).mock.calls[0]![0].message).toBe('boom');
    });

    it('never throws from a start listener either', () => {
      const bad = sink({ isDisabled: () => { throw new Error('start-boom'); } });
      setSink(bad);
      expect(() => c.emit('commandStarted', { requestId: 1, connectionId: 1, databaseName: 'app', commandName: 'find', command: { find: 'o' } })).not.toThrow();
      expect((bad.onError as Mock).mock.calls[0]![0].message).toBe('start-boom');
    });

    it('survives an onError that throws', () => {
      const bad = sink({ onError: () => { throw new Error('again'); } });
      vi.spyOn(bad.aggregator, 'add').mockImplementation(() => { throw new Error('boom'); });
      setSink(bad);
      expect(() => run(c, 'find', { find: 'o', filter: {} })).not.toThrow();
    });

    it('survives malformed events', () => {
      expect(() => c.emit('commandStarted', null)).not.toThrow();
      expect(() => c.emit('commandSucceeded', undefined)).not.toThrow();
      expect(() => c.emit('commandStarted', { requestId: 2, databaseName: 'app', commandName: 'killCursors', command: { killCursors: 'd', cursors: 'nope' } })).not.toThrow();
    });

    it('does nothing while disabled or with no sink', () => {
      setSink(sink({ isDisabled: () => true, aggregator: s.aggregator }));
      run(c, 'find', { find: 'o', filter: {} });
      expect(s.aggregator.swap().items).toHaveLength(0);
      expect(clientStats(c)!.inFlight).toBe(0);
      setSink(null);
      run(c, 'find', { find: 'o', filter: {} });
      expect(clientStats(c)!.inFlight).toBe(0);
    });

    it('drops the in-flight entry even if the sink went away before the end', () => {
      c.emit('commandStarted', { requestId: 777, connectionId: 1, databaseName: 'app', commandName: 'find', command: { find: 'o', filter: {} } });
      expect(clientStats(c)!.inFlight).toBe(1);
      setSink(null);
      c.emit('commandSucceeded', { requestId: 777, connectionId: 1, duration: 150, commandName: 'find', reply: { ok: 1 } });
      expect(clientStats(c)!.inFlight).toBe(0);
    });

    it('hands the raw (unredacted) sample input to the aggregator only when capture is on', () => {
      for (const capture of [true, false]) {
        const s2 = sink({ captureRawSample: () => capture });
        setSink(s2);
        const add = vi.spyOn(s2.aggregator, 'add');
        run(c, 'find', { find: 'o', filter: { a: 1 } });
        const args = add.mock.calls[0]!;
        expect(args[2]).toEqual({ filter: { a: '<number>' } });
        expect(args[3]).toEqual(capture ? { filter: { a: 1 } } : undefined);
        expect(args[4]).toBe('o');
      }
    });

    it('a command object mutated after the reply does not change the captured sample', () => {
      setSink(sink({ captureRawSample: () => true, aggregator: s.aggregator }));
      const command = { aggregate: 'o', pipeline: [{ $match: { region: 'IN' } }], cursor: {} };
      run(c, 'aggregate', command, { reply: { cursor: { id: 0, firstBatch: [] } } });
      (command.pipeline[0]!.$match as { region: string }).region = 'US';
      command.pipeline.push({ $match: { region: 'X' } });
      expect(s.aggregator.swap().items[0]!.sampleText).toBe('{"pipeline":[{"$match":{"region":"IN"}}]}');
    });
  });
});

/** Driver 4+ shape: a monitorCommands setter, and a flag that says 'on' though the topology may ignore it. */
class Fake6 extends EventEmitter {
  options = { monitorCommands: true };
  get monitorCommands() { return this.options.monitorCommands; }
  set monitorCommands(v: boolean) { this.options.monitorCommands = v; }
}
const cycle = (c: EventEmitter, n = 1) => {
  for (let i = 0; i < n; i++) {
    c.emit('connectionCheckedOut', { connectionId: 1, address: 'h:1' });
    c.emit('connectionCheckedIn', { connectionId: 1, address: 'h:1' });
  }
};

describe('monitoring-off probe (CMAP check-ins with no command events)', () => {
  let s: MonitorSink;
  const warned = () => (s.onError as Mock).mock.calls.filter(([e]) => (e as Error).message === MONITORING_OFF_WARNING);
  beforeEach(() => { s = sink(); setSink(s); });

  it('is a small fixed number of cycles', () => {
    expect(MONITORING_PROBE_CYCLES).toBe(3);
  });

  it('warns once when a driver 4+ client checks connections out and in but never emits a command event', () => {
    const c = new Fake6();
    attachClient(c);
    cycle(c, MONITORING_PROBE_CYCLES - 1);
    expect(warned()).toHaveLength(0);
    cycle(c);
    expect(warned()).toHaveLength(1);
    cycle(c, 10);
    attachClient(c);
    expect(warned()).toHaveLength(1);
  });

  it('never warns once a command event is seen, nor for a client that runs nothing', () => {
    const quiet = new Fake6();
    attachClient(quiet);
    expect(warned()).toHaveLength(0);

    const c = new Fake6();
    attachClient(c);
    cycle(c); // driver 7's connect-time ping: a checkout with no command
    run(c, 'find', { find: 'o', filter: {} });
    cycle(c, 20);
    expect(warned()).toHaveLength(0);
  });

  it('only counts check-ins of connections checked out after attach', () => {
    const c = new Fake6();
    attachClient(c);
    for (let i = 0; i < 10; i++) c.emit('connectionCheckedIn', { connectionId: i });
    expect(warned()).toHaveLength(0);
  });

  it('does not probe a driver 3 client (no monitorCommands setter)', () => {
    const c = new FakeClient();
    attachClient(c);
    cycle(c, 10);
    expect(warned()).toHaveLength(0);
  });

  it('stays quiet while the SDK is disabled or has no sink', () => {
    const c = new Fake6();
    attachClient(c);
    setSink(sink({ isDisabled: () => true, onError: s.onError }));
    cycle(c, 10);
    setSink(null);
    cycle(c, 10);
    expect(warned()).toHaveLength(0);
  });

  it('never throws when onError throws', () => {
    setSink(sink({ onError: () => { throw new Error('boom'); } }));
    const c = new Fake6();
    attachClient(c);
    expect(() => cycle(c, 5)).not.toThrow();
  });
});
