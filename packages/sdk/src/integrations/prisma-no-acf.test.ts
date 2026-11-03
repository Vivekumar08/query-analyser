import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { sqlRuntime, type SqlFrame } from '../sql/context.js';
import type { StatementEvent } from '../sql/core.js';

// Node 20/22: no AsyncContextFrame. AsyncLocalStorage.run() there turns on promise hooks for the whole
// process, so the hook must not open a frame for every Prisma operation (Final ruling F2).
vi.mock('../sql/async-context.js', () => ({ hasAsyncContextFrame: () => false }));

const { createOwnHelper, wrapAppHelper } = await import('./prisma.js');

/* eslint-disable @typescript-eslint/no-explicit-any */
const rt = sqlRuntime();
let rec: { events: StatementEvent[]; record(ev: StatementEvent): void };
const opSpan = (method: string, model?: string) => ({ name: 'operation', attributes: model ? { method, model } : { method } });
const dbSpan = (text: string) => ({ name: 'db_query', attributes: { 'db.query.text': text } });
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 1));

beforeEach(() => { rec = { events: [], record(ev) { this.events.push(ev); } }; rt.sink = rec; rt.pgCoversPrismaAdapter = false; });
afterEach(() => { rt.sink = null; });

describe('without AsyncContextFrame', () => {
  it('the own helper runs an operation callback with no frame and returns what it returns', () => {
    const h = createOwnHelper() as any;
    let seen: SqlFrame | undefined = { kind: 'operation', model: 'x', operation: 'x' };
    const out = h.runInChildSpan(opSpan('findMany', 'User'), () => { seen = rt.als.getStore(); return 'rows'; });
    expect(out).toBe('rows');
    expect(seen).toBeUndefined();
  });

  it("an app helper's operation span is not framed either; the app's callback still gets its arguments", () => {
    const app = { runInChildSpan: vi.fn((_o: unknown, cb: (s: unknown) => unknown) => cb('span')) };
    const h = wrapAppHelper(app) as any;
    let seen: SqlFrame | undefined; let arg: unknown;
    expect(h.runInChildSpan(opSpan('create', 'Order'), (s: unknown) => { arg = s; seen = rt.als.getStore(); return 7; })).toBe(7);
    expect(arg).toBe('span');
    expect(seen).toBeUndefined();
  });

  it("an app-enabled db_query still gets a statement frame (exactly-once), labelled with no model", async () => {
    const h = createOwnHelper() as any;
    let st: SqlFrame | undefined;
    await h.runInChildSpan(opSpan('findMany', 'User'), () => h.runInChildSpan(dbSpan('SELECT 1'), async () => { st = rt.als.getStore(); }));
    await tick();
    expect(st).toEqual({ kind: 'statement', op: null, claimed: false });
    expect(rec.events.map((e) => e.labels)).toEqual([{ orm: 'prisma', model: null, operation: null }]);
  });
});
