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

  it('handles boxed primitives without leaking length', () => {
    expect(redact(new String('a-nineteen-char-str'))).toBe('<string>');
    expect(redact(new Number(42))).toBe('<number>');
    expect(redact(new Boolean(true))).toBe('<boolean>');
  });

  it('recognises Map and Set', () => {
    expect(redact(new Map())).toBe('<Map>');
    expect(redact(new Set())).toBe('<Set>');
    expect(redact(new Map([['key', 'secret']]))).toBe('<Map>');
    expect(redact(new Set(['secret']))).toBe('<Set>');
  });

  it('keeps object keys and redacts values recursively', () => {
    expect(redact({ status: 'paid', createdAt: { $gte: new Date() } })).toEqual({
      status: '<string>',
      createdAt: { $gte: '<Date>' },
    });
  });

  it('summarises scalar arrays by element type without keeping length-dependent data', () => {
    expect(redact(['a', 'b', 'c'])).toBe('<array[string]>');
    expect(redact([1, 'a'])).toBe('<array[mixed]>');
    expect(redact([])).toBe('<array[]>');
  });

  // Important 6: an array of OBJECTS (an aggregate pipeline, a $or clause)
  // used to collapse to a useless '<array[object]>' token. It now recurses
  // into each element, keeping keys and redacting values, same as any
  // other object — this is what makes the dashboard sample useful for
  // aggregates and $or/$in filters.
  it('recurses into arrays of objects instead of collapsing them to a token', () => {
    expect(redact({ $or: [{ status: 'paid' }, { total: { $gte: 5 } }] })).toEqual({
      $or: [{ status: '<string>' }, { total: { $gte: '<number>' } }],
    });
  });

  it('bounds array recursion to the first 8 elements', () => {
    const arr = Array.from({ length: 20 }, (_, i) => ({ n: i }));
    const result = redact(arr) as unknown[];
    expect(result).toHaveLength(9); // 8 elements + '<truncated>'
    expect(result[8]).toBe('<truncated>');
    expect(result[0]).toEqual({ n: '<number>' });
  });

  it('respects the depth limit when recursing into arrays', () => {
    const deep = { a: { b: { c: { d: [{ e: 'secret' }] } } } };
    const result = redact(deep) as Record<string, unknown>;
    // depth: a=1, b=2, c=3, d(array)=4 >= MAX_DEPTH(5)? d is at depth 4,
    // still under the limit, so it recurses one more level into the array's
    // object element, which then hits the depth ceiling.
    expect(JSON.stringify(result)).not.toContain('secret');
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

  it('truncates objects beyond MAX_KEYS with truncation marker', () => {
    const obj: Record<string, number> = {};
    for (let i = 0; i < 40; i++) {
      obj[`key${i}`] = i;
    }
    const result = redact(obj) as Record<string, unknown>;
    const keys = Object.keys(result);
    expect(keys).toHaveLength(33); // 32 keys + '…'
    expect(result['…']).toBe('<truncated>');
  });

  it('handles throwing getters without throwing', () => {
    const obj = {
      x: 1,
      get y() {
        throw new Error('boom');
      },
    };
    expect(() => redact(obj)).not.toThrow();
    expect(redact(obj)).toEqual({
      x: '<number>',
      y: '<error>',
    });
  });

  it('handles Proxy with throwing get trap and real keys', () => {
    const proxy = new Proxy({ a: 1 }, {
      get() {
        throw new Error('get trap throws');
      },
    });
    expect(() => redact(proxy)).not.toThrow();
    expect(redact(proxy)).toEqual({
      a: '<error>',
    });
  });

  it('never throws on hostile inputs', () => {
    const testCases = [
      // Throwing getter
      Object.defineProperty({}, 'x', {
        get() {
          throw new Error('getter throws');
        },
      }),
      // Proxy with throwing ownKeys trap
      new Proxy({}, {
        ownKeys() {
          throw new Error('ownKeys trap');
        },
      }),
      // Proxy with throwing getOwnPropertyDescriptor trap
      new Proxy({}, {
        getOwnPropertyDescriptor() {
          throw new Error('getOwnPropertyDescriptor trap');
        },
      }),
      // Proxy with throwing get trap and real key
      new Proxy({ a: 1 }, {
        get() {
          throw new Error('get trap');
        },
      }),
      // Frozen object
      Object.freeze({ a: 1 }),
      // Object.create(null)
      Object.create(null),
      // Boxed String
      new String('secret'),
      // Map
      new Map([['key', 'value']]),
      // Sparse array
      [, , 1],
      // Symbol
      Symbol('test'),
      // BigInt
      BigInt(42),
      // Function
      () => {},
    ];
    testCases.forEach((testCase) => {
      expect(() => redact(testCase)).not.toThrow();
    });
  });

  it('handles throwing elements in arrays without throwing', () => {
    const hostileProxy = new Proxy({}, {
      get() {
        throw new Error('hostile element');
      },
    });
    // A throwing element can't be proven scalar, so isAllScalar() falls back
    // to structural recursion (the safer default) rather than the collapsed
    // token — the array is redacted element-by-element instead of as a
    // whole. Either way it must never throw and never leak anything.
    expect(() => redact([hostileProxy, 1])).not.toThrow();
    const result = redact([hostileProxy, 1]);
    expect(Array.isArray(result)).toBe(true);
    expect(JSON.stringify(result)).not.toContain('hostile');
  });

  it('transmits keys by design', () => {
    const result = redact({ ['user_' + 'x@y.z']: 1 }) as Record<string, unknown>;
    expect(result).toEqual({ 'user_x@y.z': '<number>' });
    expect(Object.keys(result)).toContain('user_x@y.z');
  });

  it('maintains vocabulary invariant for type tokens', () => {
    const secret = 'super-secret-email@example.com';
    const anotherSecret = 123456789;
    const fixture = {
      email: secret,
      nested: { list: [secret, anotherSecret] },
      date: new Date(),
      id: new Types.ObjectId(),
    };
    const result = redact(fixture);
    const output = JSON.stringify(result);

    // All string leaves must match the type token pattern
    const validateTokens = (obj: unknown): boolean => {
      if (typeof obj === 'string') {
        return /^<[A-Za-z\[\]]+>$/.test(obj);
      }
      if (typeof obj === 'object' && obj !== null && !Array.isArray(obj)) {
        return Object.values(obj as Record<string, unknown>).every(validateTokens);
      }
      return true;
    };
    expect(validateTokens(result)).toBe(true);

    // No secret values must appear in output
    expect(output).not.toContain('super-secret');
    expect(output).not.toContain('123456789');
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
