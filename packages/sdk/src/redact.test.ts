import { describe, it, expect } from 'vitest';
import { Types } from 'mongoose';
import { redact } from './redact.js';

describe('redact', () => {
  it('replaces scalars with type tokens', () => {
    expect(redact('abc')).toBe('<string>');
    expect(redact(42)).toBe('<number>');
    expect(redact(true)).toBe('<boolean>');
    expect(redact(null)).toBe('<null>');
    expect(redact(undefined)).toBe('<undefined>');
  });

  it('recognises ObjectId, Date and RegExp', () => {
    expect(redact(new Types.ObjectId())).toBe('<ObjectId>');
    expect(redact(new Date())).toBe('<Date>');
    expect(redact(/abc/i)).toBe('<RegExp>');
  });

  it('keeps object keys and redacts values recursively', () => {
    expect(redact({ status: 'paid', createdAt: { $gte: new Date() } })).toEqual({
      status: '<string>',
      createdAt: { $gte: '<Date>' },
    });
  });

  it('summarises arrays by element type without keeping length-dependent data', () => {
    expect(redact(['a', 'b', 'c'])).toBe('<array[string]>');
    expect(redact([1, 'a'])).toBe('<array[mixed]>');
    expect(redact([])).toBe('<array[]>');
  });

  it('truncates beyond the depth limit rather than recursing forever', () => {
    expect(redact({ a: { b: { c: { d: { e: { f: 1 } } } } } })).toEqual({
      a: { b: { c: { d: { e: '<object>' } } } },
    });
  });

  it('survives a circular structure', () => {
    const o: Record<string, unknown> = { a: 1 };
    o.self = o;
    expect(() => redact(o)).not.toThrow();
  });

  it('leaks no input value anywhere in the output', () => {
    const secret = 'super-secret-email@example.com';
    const out = JSON.stringify(
      redact({ email: secret, nested: { list: [secret] }, n: 918273 }),
    );
    expect(out).not.toContain('super-secret');
    expect(out).not.toContain('918273');
  });
});
