import { describe, it, expect } from 'vitest';
import { adviceFor } from './advice.js';

describe('adviceFor', () => {
  it('orders equality, then sort, then range', () => {
    const r = adviceFor(
      [
        { key: 'status', op: 'eq' },
        { key: 'createdAt', op: 'range' },
      ],
      [{ key: 'placedAt', dir: -1 }],
    );
    expect(Object.keys(r!.suggestion)).toEqual(['status', 'placedAt', 'createdAt']);
    expect(r!.suggestion).toEqual({ status: 1, placedAt: -1, createdAt: 1 });
  });

  it('treats $in as equality', () => {
    const r = adviceFor([{ key: 'tenant', op: 'in' }], []);
    expect(Object.keys(r!.suggestion)).toEqual(['tenant']);
  });

  it('excludes regex, ne and other, and names them in the rationale', () => {
    const r = adviceFor(
      [
        { key: 'status', op: 'eq' },
        { key: 'name', op: 'regex' },
        { key: 'kind', op: 'ne' },
        { key: 'misc', op: 'other' },
      ],
      [],
    );
    expect(Object.keys(r!.suggestion)).toEqual(['status']);
    expect(r!.rationale).toContain('name');
    expect(r!.rationale).toContain('kind');
    expect(r!.rationale).toContain('misc');
  });

  it('places exists after the sort keys, with the range fields', () => {
    const r = adviceFor(
      [
        { key: 'deletedAt', op: 'exists' },
        { key: 'status', op: 'eq' },
      ],
      [{ key: 'placedAt', dir: 1 }],
    );
    expect(Object.keys(r!.suggestion)).toEqual(['status', 'placedAt', 'deletedAt']);
  });

  it('gives no advice for an empty shape', () => {
    expect(adviceFor([], [])).toBeNull();
  });

  it('gives no advice when the filter is only _id', () => {
    // _id is always indexed. Suggesting it is noise.
    expect(adviceFor([{ key: '_id', op: 'eq' }], [])).toBeNull();
  });

  it('gives no advice when every field is unindexable', () => {
    expect(adviceFor([{ key: 'name', op: 'regex' }], [])).toBeNull();
  });

  it('says plainly that this is a shape heuristic, not a verified plan', () => {
    const r = adviceFor([{ key: 'status', op: 'eq' }], []);
    expect(r!.rationale).toMatch(/heuristic|never seen/i);
  });

  it('excludes _id from equality fields when mixed with meaningful fields', () => {
    const r = adviceFor([{ key: '_id', op: 'eq' }, { key: 'status', op: 'eq' }], []);
    expect(Object.keys(r!.suggestion)).toEqual(['status']);
  });

  it('excludes _id from range fields when mixed with meaningful fields', () => {
    const r = adviceFor([{ key: '_id', op: 'range' }, { key: 'status', op: 'eq' }], []);
    expect(Object.keys(r!.suggestion)).toEqual(['status']);
  });
});
