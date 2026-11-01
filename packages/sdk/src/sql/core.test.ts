import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./lexer.js', async (importOriginal) => {
  const m = await importOriginal<typeof import('./lexer.js')>();
  return { ...m, lex: vi.fn(m.lex) };
});

import { lex } from './lexer.js';
import { maskName } from './fingerprint.js';
import { Aggregator } from '../aggregator.js';
import { toWireItem } from '../wire-item.js';
import { createSqlSink, sqlStateOf, type SqlSinkOptions, type StatementEvent } from './core.js';

const KEY = Buffer.from('k'.repeat(32));

function ev(over: Partial<StatementEvent> = {}): StatementEvent {
  return { text: 'SELECT * FROM users WHERE id = 1', database: 'shop', durationMs: 5, failed: false, errorCode: null, labels: null, ...over };
}

function seq(values: number[]): () => number {
  let i = 0;
  return () => values[i++] ?? 0;
}

const sum = (xs: readonly number[] | undefined): number => (xs ?? []).reduce((a, b) => a + b, 0);

let agg: Aggregator;
let onError: ReturnType<typeof vi.fn>;
let opts: SqlSinkOptions;
let sink: ReturnType<typeof createSqlSink>;

beforeEach(() => {
  agg = new Aggregator(100);
  onError = vi.fn();
  opts = { aggregator: agg, thresholdMs: 100, sampleRate: 1, maskIdentifiers: false, isDisabled: () => false, onError };
  sink = createSqlSink(opts);
});

describe('sql sink', () => {
  it('records a raw statement under its table and verb', () => {
    sink.record(ev());
    expect(toWireItem(agg.swap().items[0]!)).toMatchObject({ model: 'users', operation: 'select', collection: 'users', source: 'postgresql',
      database: 'shop', sql: 'SELECT * FROM users WHERE id = ?', count: 1, hist: [0, 0, 0, 0, 0, 0, 0, 0] });
    expect(onError).not.toHaveBeenCalled();
  });

  it('uses Prisma labels when given', () => {
    sink.record(ev({ labels: { orm: 'prisma', model: 'User', operation: 'findUnique' } }));
    const item = toWireItem(agg.swap().items[0]!);
    expect(item).toMatchObject({ orm: 'prisma', model: 'User', operation: 'findUnique', collection: 'users' });
  });

  it('Prisma labels with null model and operation fall back to the table and verb', () => {
    sink.record(ev({ labels: { orm: 'prisma', model: null, operation: null } }));
    expect(toWireItem(agg.swap().items[0]!)).toMatchObject({ orm: 'prisma', model: 'users', operation: 'select' });
  });

  it('a statement with no table is labelled (sql)', () => {
    sink.record(ev({ text: 'SELECT 1', database: null }));
    const item = toWireItem(agg.swap().items[0]!);
    expect(item).toMatchObject({ model: '(sql)', operation: 'select', collection: '(sql)' });
    expect(item).not.toHaveProperty('database');
    expect(item).not.toHaveProperty('orm');
  });

  it('ignores control statements', () => {
    sink.record(ev({ text: 'BEGIN' }));
    expect(agg.swap().items).toHaveLength(0);
    expect(onError).not.toHaveBeenCalled();
  });

  it('a statement at the threshold is slow, one below is not', () => {
    sink.record(ev({ durationMs: 100 }));
    const slow = toWireItem(agg.swap().items[0]!);
    expect(slow.hist[1]).toBe(1);
    sink.record(ev({ durationMs: 99.9 }));
    const fast = toWireItem(agg.swap().items[0]!);
    expect(sum(fast.hist)).toBe(0);
    expect(sum(fast.histFine)).toBe(1);
    expect(fast.count).toBe(1);
  });

  it('a failure counts as an error with its SQLSTATE, whatever its duration', () => {
    sink.record(ev({ failed: true, errorCode: '23505', durationMs: 2 }));
    expect(toWireItem(agg.swap().items[0]!)).toMatchObject({ errors: 1, errorCodes: [{ code: '23505', count: 1 }], count: 1 });
  });

  it('a failure with a malformed code counts as an error without a code', () => {
    sink.record(ev({ failed: true, errorCode: 'ECONNRESET' }));
    sink.record(ev({ failed: true, errorCode: '2350a' }));
    const item = toWireItem(agg.swap().items[0]!);
    expect(item.errors).toBe(2);
    expect(item).not.toHaveProperty('errorCodes');
  });

  it('a code on a statement that did not fail is ignored', () => {
    sink.record(ev({ failed: false, errorCode: '23505' }));
    const item = toWireItem(agg.swap().items[0]!);
    expect(item.errors).toBe(0);
    expect(item).not.toHaveProperty('errorCodes');
  });
});

describe('sql sink sampling', () => {
  it('samples only fast successes; slow ones and failures are always kept', () => {
    const s = createSqlSink({ ...opts, sampleRate: 0.1, random: seq([0.5, 0.05]) });
    s.record(ev()); s.record(ev());                                // first skipped, second kept with weight 10
    s.record(ev({ durationMs: 150 })); s.record(ev({ failed: true }));
    expect(toWireItem(agg.swap().items[0]!)).toMatchObject({ count: 12, errors: 1, sampleRate: 0.1 });
  });

  it('a skipped statement is never fingerprinted', () => {
    const spy = vi.mocked(lex);
    spy.mockClear();
    const s = createSqlSink({ ...opts, sampleRate: 0.1, random: () => 0.9 });
    s.record(ev({ text: 'SELECT * FROM never_seen WHERE id = 7' }));
    expect(spy).toHaveBeenCalledTimes(0);
    expect(agg.swap().items).toHaveLength(0);
  });

  it('at sampleRate 1 random is never consulted', () => {
    const random = vi.fn(() => 0.99);
    createSqlSink({ ...opts, random }).record(ev());
    expect(random).not.toHaveBeenCalled();
    expect(toWireItem(agg.swap().items[0]!)).not.toHaveProperty('sampleRate');
  });

  it.each([0, -0.5, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MIN_VALUE / 2])(
    'an invalid sampleRate %s records nothing and reports to onError, never a NaN or Infinity count',
    (rate) => {
      const s = createSqlSink({ ...opts, sampleRate: rate, random: () => 0 });
      expect(() => { s.record(ev()); s.record(ev({ durationMs: 500 })); s.record(ev({ failed: true })); }).not.toThrow();
      expect(agg.swap().items).toHaveLength(0);
      expect(onError).toHaveBeenCalled();
      expect(onError.mock.calls[0]![0]).toBeInstanceOf(Error);
    },
  );

  it('a tiny valid sampleRate whose weight overflows is rejected', () => {
    const s = createSqlSink({ ...opts, sampleRate: 1e-320, random: () => 0 });
    s.record(ev());
    expect(agg.swap().items).toHaveLength(0);
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it.each([Number.NaN, -1, Number.POSITIVE_INFINITY])('an invalid duration %s records nothing and reports to onError', (ms) => {
    sink.record(ev({ durationMs: ms }));
    expect(agg.swap().items).toHaveLength(0);
    expect(onError).toHaveBeenCalledTimes(1);
  });
});

describe('sql sink masking and limits', () => {
  it('masks the model, table and database', () => {
    const s = createSqlSink({ ...opts, maskIdentifiers: true, maskKey: KEY });
    s.record(ev({ text: 'SELECT * FROM patients WHERE id = 1', database: 'clinic',
      labels: { orm: 'prisma', model: 'Patient', operation: 'findMany' } }));
    const item = toWireItem(agg.swap().items[0]!);
    expect(item).toMatchObject({ model: maskName('Patient', KEY), database: maskName('clinic', KEY),
      collection: maskName('patients', KEY), operation: 'findMany', orm: 'prisma' });
    const json = JSON.stringify(item);
    for (const name of ['Patient', 'clinic', 'patients']) expect(json).not.toContain(name);
  });

  it('a masked raw statement takes its masked table as the model', () => {
    const s = createSqlSink({ ...opts, maskIdentifiers: true, maskKey: KEY });
    s.record(ev());
    const item = toWireItem(agg.swap().items[0]!);
    expect(item.model).toBe(maskName('users', KEY));
    expect(item.collection).toBe(maskName('users', KEY));
    expect(item.database).toBe(maskName('shop', KEY));
    expect(JSON.stringify(item)).not.toMatch(/users|shop/);
  });

  it('the mask key is passed through to the fingerprint', () => {
    const other = new Aggregator(100);
    createSqlSink({ ...opts, maskIdentifiers: true, maskKey: KEY }).record(ev());
    createSqlSink({ ...opts, aggregator: other, maskIdentifiers: true, maskKey: 'another key' }).record(ev());
    const a = toWireItem(agg.swap().items[0]!);
    const b = toWireItem(other.swap().items[0]!);
    expect(a.hash).not.toBe(b.hash);
    expect(a.sql).toContain(maskName('users', KEY));
  });

  it('caps signature, model, operation and database', () => {
    const cols = Array.from({ length: 120 }, (_, i) => `c${i}`).join(', ');
    sink.record(ev({ text: `SELECT ${cols} FROM users`, database: 'd'.repeat(300),
      labels: { orm: 'prisma', model: 'M'.repeat(300), operation: 'o'.repeat(50) } }));
    const item = toWireItem(agg.swap().items[0]!);
    expect(item.signature.length).toBe(400);
    expect(item.sql!.length).toBeGreaterThan(400);
    expect(item.model).toBe('M'.repeat(200));
    expect(item.operation).toBe('o'.repeat(40));
    expect(item.database).toBe('d'.repeat(255));
  });
});

describe('sql sink guards', () => {
  it('records nothing while disabled', () => {
    const random = vi.fn(() => 0);
    const s = createSqlSink({ ...opts, sampleRate: 0.5, random, isDisabled: () => true });
    s.record(ev()); s.record(ev({ failed: true }));
    expect(agg.swap().items).toHaveLength(0);
    expect(random).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  it('never throws when the aggregator does', () => {
    const boom = new Error('boom');
    vi.spyOn(agg, 'addStatement').mockImplementation(() => { throw boom; });
    expect(() => sink.record(ev())).not.toThrow();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(boom);
  });

  it('never throws when isDisabled or onError does', () => {
    const s = createSqlSink({ ...opts, isDisabled: () => { throw new Error('x'); }, onError: () => { throw new Error('y'); } });
    expect(() => s.record(ev())).not.toThrow();
  });

  it('a non-Error throw reaches onError as an Error', () => {
    vi.spyOn(agg, 'addStatement').mockImplementation(() => { throw 'str'; });
    sink.record(ev());
    expect(onError.mock.calls[0]![0]).toBeInstanceOf(Error);
  });
});

describe('sqlStateOf', () => {
  it('sqlStateOf reads only a five-character code', () => {
    expect(sqlStateOf({ code: '23505', detail: 'Key (email)=(a@b.c)' })).toBe('23505');
    expect(sqlStateOf({ code: 'ECONNRESET' })).toBeNull();
    expect(sqlStateOf(null)).toBeNull();
  });

  it('rejects lower case, non-strings and missing codes, and reads nothing else', () => {
    expect(sqlStateOf({ code: '2350a' })).toBeNull();
    expect(sqlStateOf({ code: 23505 })).toBeNull();
    expect(sqlStateOf({})).toBeNull();
    expect(sqlStateOf('23505')).toBeNull();
    expect(sqlStateOf(undefined)).toBeNull();
    const read: string[] = [];
    const err = new Proxy({ code: '42P01', message: 'secret', detail: 'secret' }, {
      get(t, p, r) { read.push(String(p)); return Reflect.get(t, p, r); },
    });
    expect(sqlStateOf(err)).toBe('42P01');
    expect(read).toEqual(['code']);
  });

  it('a throwing code getter gives null', () => {
    expect(sqlStateOf({ get code(): string { throw new Error('no'); } })).toBeNull();
  });
});
