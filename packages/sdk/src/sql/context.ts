import { AsyncLocalStorage } from 'node:async_hooks';
import type { SqlSink } from './core.js';

/** A Prisma operation in progress (`prisma.user.findMany(...)`). */
export interface OperationFrame { readonly kind: 'operation'; readonly model: string | null; readonly operation: string }
/** One SQL statement in progress; `claimed` once a layer has counted it. */
export interface StatementFrame { readonly kind: 'statement'; readonly op: OperationFrame | null; claimed: boolean }
export type SqlFrame = OperationFrame | StatementFrame;

export interface Labels { orm: string; model: string | null; operation: string | null }

export interface SqlRuntime {
  readonly als: AsyncLocalStorage<SqlFrame>;
  /** The active analyser's sink, whichever SDK copy installed the hooks. */
  sink: SqlSink | null;
  /** Set by init(); enables the adapter-shape inference (Decision 5). */
  prismaAdapterResolved: boolean;
  /**
   * Set by init() from `pgCoversAdapter()`: the pg wrap covers `@prisma/adapter-pg`'s own pg, so the
   * pg layer counts every Prisma statement and the Prisma helper records none (Task 5 ruling).
   * Optional: a runtime created by an older SDK copy lacks it, which reads as false.
   */
  pgCoversPrismaAdapter?: boolean;
}

export const SQL_RUNTIME: unique symbol = Symbol.for('query-analyser.sql-runtime') as typeof SQL_RUNTIME;

/**
 * The process-wide SQL runtime. It lives on `globalThis` under a registered symbol, so every
 * copy of the SDK in one process (nested installs, ESM and CJS builds) shares one frame store
 * and one sink slot. Created once, non-enumerable.
 */
export function sqlRuntime(): SqlRuntime {
  const g = globalThis as unknown as Record<symbol, SqlRuntime | undefined>;
  const existing = g[SQL_RUNTIME];
  if (existing !== undefined) return existing;
  const value: SqlRuntime = { als: new AsyncLocalStorage<SqlFrame>(), sink: null, prismaAdapterResolved: false, pgCoversPrismaAdapter: false };
  Object.defineProperty(globalThis, SQL_RUNTIME, { value, enumerable: false, configurable: true, writable: false });
  return value;
}

/** Prisma labels for a frame: an operation's own, a statement's operation's, or Prisma with no model. */
export function labelsOf(frame: SqlFrame | undefined): Labels | null {
  if (frame === undefined) return null;
  const op = frame.kind === 'operation' ? frame : frame.op;
  if (op == null) return { orm: 'prisma', model: null, operation: null }; // == null: a malformed frame from another SDK version
  return { orm: 'prisma', model: op.model, operation: op.operation };
}
