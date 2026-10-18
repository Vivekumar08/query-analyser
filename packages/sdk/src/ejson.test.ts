import { describe, it, expect, vi } from 'vitest';
import mongoose from 'mongoose';
import { serializeSample } from './ejson.js';

const parse = (value: unknown) => JSON.parse(serializeSample(value)!) as unknown;

describe('serializeSample', () => {
  it('writes an ObjectId as {"$oid"}', () => {
    const id = new mongoose.Types.ObjectId('65f0c0ffee0000000000abcd');
    expect(parse({ _id: id })).toEqual({ _id: { $oid: '65f0c0ffee0000000000abcd' } });
  });

  it('writes a Date as {"$date": ISO}', () => {
    const d = new Date('2026-10-19T08:30:00.000Z');
    expect(parse({ at: d })).toEqual({ at: { $date: '2026-10-19T08:30:00.000Z' } });
  });

  it('writes an invalid Date without throwing', () => {
    expect(parse({ at: new Date('nope') })).toEqual({ at: { $date: null } });
  });

  it('writes a RegExp as {"$regex","$options"}', () => {
    expect(parse({ email: /^ana@/i })).toEqual({ email: { $regex: '^ana@', $options: 'i' } });
  });

  it('writes a Decimal128 as {"$numberDecimal"}', () => {
    const dec = mongoose.Types.Decimal128.fromString('19.99');
    expect(parse({ price: dec })).toEqual({ price: { $numberDecimal: '19.99' } });
  });

  it('writes a Buffer as {"$binary":{"base64"}}', () => {
    expect(parse({ blob: Buffer.from('hello') })).toEqual({
      blob: { $binary: { base64: 'aGVsbG8=', subType: '00' } },
    });
  });

  it('writes a bson Binary as {"$binary"} with its subtype', () => {
    const bin = new mongoose.mongo.Binary(Buffer.from('hi'), 4);
    expect(parse({ uuid: bin })).toEqual({ uuid: { $binary: { base64: 'aGk=', subType: '04' } } });
  });

  it('turns a Map into an array of pairs and a Set into an array', () => {
    expect(parse({ m: new Map([['a', 1]]), s: new Set([1, 2]) })).toEqual({
      m: [['a', 1]],
      s: [1, 2],
    });
  });

  it('replaces a circular reference with "<circular>"', () => {
    const a: Record<string, unknown> = { x: 1 };
    a.self = a;
    expect(parse({ filter: a })).toEqual({ filter: { x: 1, self: '<circular>' } });
  });

  it('keeps a shared (non-circular) object both times', () => {
    const shared = { k: 1 };
    expect(parse({ a: shared, b: [shared] })).toEqual({ a: { k: 1 }, b: [{ k: 1 }] });
  });

  it('keeps plain values and nested operators intact', () => {
    const sample = { filter: { status: 'paid', total: { $gte: 10 }, tags: { $in: ['a', 'b'] }, ok: true, n: null } };
    expect(parse(sample)).toEqual(sample);
  });

  it('omits undefined object keys like JSON does', () => {
    expect(parse({ a: undefined, b: 1 })).toEqual({ b: 1 });
  });

  it('writes non-finite numbers and bigints as extended-JSON wrappers', () => {
    expect(parse({ a: NaN, b: Infinity, c: 12n })).toEqual({
      a: { $numberDouble: 'NaN' },
      b: { $numberDouble: 'Infinity' },
      c: { $numberLong: '12' },
    });
  });

  it('returns null instead of throwing when a getter throws', () => {
    const evil = { get boom() { throw new Error('nope'); } };
    expect(serializeSample({ evil })).toBeNull();
  });

  it('returns null when the output is over 16 KiB', () => {
    expect(serializeSample({ s: 'x'.repeat(16_384) })).toBeNull();
  });

  it('counts the cap in UTF-8 bytes, not characters', () => {
    // 6 000 three-byte characters: 6 000 chars, 18 000 bytes.
    expect(serializeSample({ s: '€'.repeat(6_000) })).toBeNull();
  });

  it('accepts output just under the cap', () => {
    const out = serializeSample({ s: 'x'.repeat(16_000) });
    expect(out).not.toBeNull();
    expect(Buffer.byteLength(out!)).toBeLessThanOrEqual(16_384);
  });

  it('honours a custom cap', () => {
    expect(serializeSample({ s: 'x'.repeat(100) }, 50)).toBeNull();
  });

  it('rejects a 16 MB Buffer before base64-encoding it', () => {
    const big = Buffer.alloc(16 * 1024 * 1024, 1);
    const toString = vi.spyOn(Buffer.prototype, 'toString');
    try {
      const t0 = performance.now();
      expect(serializeSample({ update: { $set: { blob: big } } })).toBeNull();
      expect(performance.now() - t0).toBeLessThan(50);
      expect(toString.mock.calls.filter(([enc]) => enc === 'base64')).toHaveLength(0);
    } finally {
      toString.mockRestore();
    }
  });

  it('rejects a 20 MB string before JSON-escaping it', () => {
    const huge = 'x'.repeat(20 * 1024 * 1024);
    const stringify = vi.spyOn(JSON, 'stringify');
    try {
      const t0 = performance.now();
      expect(serializeSample({ filter: { note: huge } })).toBeNull();
      expect(performance.now() - t0).toBeLessThan(50);
      expect(stringify.mock.calls.some(([arg]) => arg === huge)).toBe(false);
    } finally {
      stringify.mockRestore();
    }
  });

  it('rejects a huge bson Binary before encoding it', () => {
    const bin = new mongoose.mongo.Binary(Buffer.alloc(8 * 1024 * 1024, 2), 0);
    const toString = vi.spyOn(Buffer.prototype, 'toString');
    try {
      expect(serializeSample({ b: bin })).toBeNull();
      expect(toString.mock.calls.filter(([enc]) => enc === 'base64')).toHaveLength(0);
    } finally {
      toString.mockRestore();
    }
  });

  it('stops early on a huge object whose keys are all skipped', () => {
    const sparse: Record<string, undefined> = {};
    for (let i = 0; i < 200_000; i++) sparse[`k${i}`] = undefined;
    const t0 = performance.now();
    expect(serializeSample({ filter: sparse })).toBeNull();
    expect(performance.now() - t0).toBeLessThan(50);
  });

  it('returns null past the depth limit', () => {
    let deep: unknown = 1;
    for (let i = 0; i < 100; i++) deep = { d: deep };
    expect(serializeSample(deep)).toBeNull();
  });

  it('writes an unknown bson type as a placeholder without stringifying it', () => {
    expect(parse({ c: { _bsontype: 'Code', code: 'function () {}' } })).toEqual({ c: '<Code>' });
  });
});
