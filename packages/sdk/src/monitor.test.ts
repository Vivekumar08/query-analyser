import { EventEmitter } from 'node:events';
import { describe, it, expect, vi, afterEach, beforeEach, type Mock } from 'vitest';
import { Aggregator } from './aggregator.js';
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
