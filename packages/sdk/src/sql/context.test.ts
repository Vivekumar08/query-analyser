import { describe, it, expect } from 'vitest';
import { AsyncLocalStorage } from 'node:async_hooks';
import { sqlRuntime, labelsOf, SQL_RUNTIME } from './context.js';

describe('sql runtime', () => {
  it('one runtime per process, shared by every module copy', () => {
    expect(sqlRuntime()).toBe(sqlRuntime());
    expect((globalThis as Record<symbol, unknown>)[Symbol.for('query-analyser.sql-runtime')]).toBe(sqlRuntime());
    expect(SQL_RUNTIME).toBe(Symbol.for('query-analyser.sql-runtime'));
  });

  it('the record is non-enumerable and starts empty', () => {
    const rt = sqlRuntime();
    const desc = Object.getOwnPropertyDescriptor(globalThis, SQL_RUNTIME);
    expect(desc?.enumerable).toBe(false);
    expect(desc?.configurable).toBe(true);
    expect(rt.als).toBeInstanceOf(AsyncLocalStorage);
    expect(rt.sink).toBeNull();
    expect(rt.prismaAdapterResolved).toBe(false);
  });

  it('a record another SDK copy created is reused', () => {
    const rt = sqlRuntime();
    rt.prismaAdapterResolved = true;
    try {
      expect(sqlRuntime().prismaAdapterResolved).toBe(true);
    } finally {
      rt.prismaAdapterResolved = false;
    }
  });

  it('labelsOf reads operation and statement frames', () => {
    const op = { kind: 'operation', model: 'User', operation: 'findMany' } as const;
    expect(labelsOf(op)).toEqual({ orm: 'prisma', model: 'User', operation: 'findMany' });
    expect(labelsOf({ kind: 'statement', op, claimed: false })).toEqual({ orm: 'prisma', model: 'User', operation: 'findMany' });
    expect(labelsOf(undefined)).toBeNull();
  });

  it('a statement frame without an operation is Prisma with no model or operation', () => {
    expect(labelsOf({ kind: 'statement', op: null, claimed: false })).toEqual({ orm: 'prisma', model: null, operation: null });
  });

  it('an operation without a model (raw query) keeps a null model', () => {
    expect(labelsOf({ kind: 'operation', model: null, operation: '$queryRaw' })).toEqual({ orm: 'prisma', model: null, operation: '$queryRaw' });
  });

  it('a malformed statement frame from another SDK version (op missing) does not crash', () => {
    const frame = { kind: 'statement', claimed: false } as unknown as Parameters<typeof labelsOf>[0];
    expect(labelsOf(frame)).toEqual({ orm: 'prisma', model: null, operation: null });
  });
});
