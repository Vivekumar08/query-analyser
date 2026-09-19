import { describe, it, expect } from 'vitest';
import { classifyOp, normalizeKey, flattenFilter, normalizeSort, buildSignature } from './signature.js';

describe('classifyOp', () => {
  it('treats plain values and $eq as equality', () => {
    expect(classifyOp('paid')).toBe('eq');
    expect(classifyOp(7)).toBe('eq');
    expect(classifyOp({ $eq: 'paid' })).toBe('eq');
  });

  it('classifies set membership', () => {
    expect(classifyOp({ $in: ['a', 'b'] })).toBe('in');
    expect(classifyOp({ $all: ['a'] })).toBe('in');
  });

  it('classifies ranges', () => {
    expect(classifyOp({ $gte: 1 })).toBe('range');
    expect(classifyOp({ $lt: 1 })).toBe('range');
    expect(classifyOp({ $gt: 1, $lte: 9 })).toBe('range');
  });

  it('classifies regex, exists and negation', () => {
    expect(classifyOp({ $regex: 'x' })).toBe('regex');
    expect(classifyOp(/x/)).toBe('regex');
    expect(classifyOp({ $exists: true })).toBe('exists');
    expect(classifyOp({ $ne: 1 })).toBe('ne');
    expect(classifyOp({ $nin: [1] })).toBe('ne');
  });

  it('falls back to other for unknown operators', () => {
    expect(classifyOp({ $mod: [2, 0] })).toBe('other');
  });
});

describe('normalizeKey', () => {
  it('collapses array indexes so positions do not fragment signatures', () => {
    expect(normalizeKey('items.0.sku')).toBe('items.$[].sku');
    expect(normalizeKey('items.13.sku')).toBe('items.$[].sku');
  });

  it('leaves ordinary paths alone', () => {
    expect(normalizeKey('user.address.city')).toBe('user.address.city');
  });
});

describe('flattenFilter', () => {
  it('returns keys sorted with their operator classes', () => {
    expect(flattenFilter({ status: 'paid', createdAt: { $gte: new Date() } })).toEqual([
      { key: 'createdAt', op: 'range' },
      { key: 'status', op: 'eq' },
    ]);
  });

  it('flattens $and and $or branches into one list', () => {
    expect(flattenFilter({ $and: [{ a: 1 }, { $or: [{ b: { $gt: 1 } }] }] })).toEqual([
      { key: 'a', op: 'eq' },
      { key: 'b', op: 'range' },
    ]);
  });

  it('deduplicates a key that appears in several branches', () => {
    expect(flattenFilter({ $or: [{ a: 1 }, { a: 2 }] })).toEqual([{ key: 'a', op: 'eq' }]);
  });

  it('records $expr and $text as opaque', () => {
    expect(flattenFilter({ $expr: { $gt: ['$a', '$b'] } })).toEqual([
      { key: '$expr', op: 'other' },
    ]);
  });

  it('returns an empty list for an empty or non-object filter', () => {
    expect(flattenFilter({})).toEqual([]);
    expect(flattenFilter(undefined)).toEqual([]);
    expect(flattenFilter(null)).toEqual([]);
  });
});

describe('normalizeSort', () => {
  it('preserves sort order and direction', () => {
    expect(normalizeSort({ placedAt: -1, name: 1 })).toEqual([
      { key: 'placedAt', dir: -1 },
      { key: 'name', dir: 1 },
    ]);
  });

  it('maps asc and desc strings to numeric directions', () => {
    expect(normalizeSort({ a: 'asc', b: 'desc' })).toEqual([
      { key: 'a', dir: 1 },
      { key: 'b', dir: -1 },
    ]);
  });

  it('returns an empty list when there is no sort', () => {
    expect(normalizeSort(undefined)).toEqual([]);
  });
});

describe('buildSignature', () => {
  it('renders a find signature with operator classes and sort', () => {
    const s = buildSignature({
      model: 'Order',
      operation: 'find',
      filter: { status: 'paid', createdAt: { $gte: new Date() } },
      sort: { placedAt: -1 },
    });
    expect(s.signature).toBe('Order.find(createdAt:range,status:eq)[placedAt:-1]');
    expect(s.hash).toMatch(/^[0-9a-f]{16}$/);
    expect(s.model).toBe('Order');
    expect(s.operation).toBe('find');
  });

  it('renders an aggregate signature from stage operators', () => {
    const s = buildSignature({
      model: 'Order',
      operation: 'aggregate',
      pipeline: [{ $match: { a: 1 } }, { $group: { _id: null } }],
    });
    expect(s.signature).toBe('Order.aggregate($match,$group)');
    expect(s.stages).toEqual(['$match', '$group']);
  });

  it('gives the same signature for the same shape with different values', () => {
    const a = buildSignature({ model: 'O', operation: 'find', filter: { s: 'paid' } });
    const b = buildSignature({ model: 'O', operation: 'find', filter: { s: 'void' } });
    expect(a.hash).toBe(b.hash);
  });

  it('gives different signatures for different operator classes on the same key', () => {
    const a = buildSignature({ model: 'O', operation: 'find', filter: { n: 1 } });
    const b = buildSignature({ model: 'O', operation: 'find', filter: { n: { $gt: 1 } } });
    expect(a.hash).not.toBe(b.hash);
  });

  it('caps the rendered signature length', () => {
    const filter: Record<string, number> = {};
    for (let i = 0; i < 200; i++) filter[`field_number_${i}`] = i;
    expect(buildSignature({ model: 'O', operation: 'find', filter }).signature.length)
      .toBeLessThanOrEqual(400);
  });
});
