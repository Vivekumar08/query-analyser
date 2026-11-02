import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, vi, afterEach, beforeEach, beforeAll, afterAll } from 'vitest';
import { Aggregator } from './aggregator.js';
import { sqlRuntime } from './sql/context.js';
import { installPgWrap, undoPgWraps, PG_QUERY_WRAP } from './integrations/pg.js';
import { setSink, type MonitorSink } from './monitor.js';
import {
  CONNECT_WRAP,
  MONITORING_OFF_WARNING,
  enableMonitoring,
  installConnectWrap,
  monitorState,
  pgClientClass,
  pgClientOf,
  pgPoolClass,
  pgPoolOf,
  prismaClientVersion,
  resolveAppPath,
  resolvePgClients,
  mongooseClients,
  requireFrom,
  resolvePeer,
  resolvePeerPath,
  undoConnectWraps,
} from './drivers.js';

const fakeSink = (over: Partial<MonitorSink> = {}): MonitorSink => ({ aggregator: new Aggregator(100), thresholdMs: 100,
  onError: vi.fn(), isDisabled: () => false, captureRawSample: () => false, resolveModel: (_d, coll) => coll, ...over });

function makeFake4() {
  class Fake4 extends EventEmitter {
    options = { monitorCommands: false };
    result = Promise.resolve(this);
    seenAtConnect?: boolean;
    get monitorCommands() { return this.options.monitorCommands; }
    set monitorCommands(v: boolean) { this.options.monitorCommands = v; }
    connect(cb?: (e?: Error) => void) {
      this.seenAtConnect = this.options.monitorCommands;
      if (cb) { cb(); return undefined; }
      return this.result;
    }
  }
  return Fake4;
}
function makeFake3() {
  class Fake3 extends EventEmitter { connect() { return Promise.resolve(this); } }
  return Fake3;
}
const hasOwn = (o: object, k: PropertyKey) => Object.prototype.hasOwnProperty.call(o, k);

beforeEach(() => setSink(fakeSink()));
afterEach(() => { undoConnectWraps(); setSink(null); vi.restoreAllMocks(); });

describe('constants', () => {
  it('CONNECT_WRAP is the shared registry symbol and the warning is verbatim', () => {
    expect(CONNECT_WRAP).toBe(Symbol.for('query-analyser.connect-wrap'));
    expect(MONITORING_OFF_WARNING).toBe(
      'query-analyser: command monitoring is off for a MongoClient, so if this client was already connected its queries are not captured. Pass `monitorCommands: true` in its connect options, or call init() before connecting.',
    );
  });
});

describe('installConnectWrap', () => {
  it('sets monitorCommands and attaches before the original connect runs, and returns its value', () => {
    const Fake4 = makeFake4();
    expect(installConnectWrap(Fake4)).toBe(true);
    const c = new Fake4();
    expect(c.connect()).toBe(c.result);
    expect(c.seenAtConnect).toBe(true);
    expect(c.listenerCount('commandStarted')).toBe(1);
    expect(Fake4.prototype.connect.name).toBe('connect');
  });

  it('passes a callback through untouched', () => {
    const Fake4 = makeFake4();
    installConnectWrap(Fake4);
    const c = new Fake4();
    const cb = vi.fn();
    expect(c.connect(cb)).toBeUndefined();
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith();
    expect(c.seenAtConnect).toBe(true);
  });

  it('passes every argument through to the original', () => {
    class Spy extends EventEmitter { connect(...args: unknown[]) { return args; } }
    installConnectWrap(Spy);
    const a = { x: 1 }; const b = () => {};
    const out = (new Spy().connect as (...x: unknown[]) => unknown[])(a, b, 3);
    expect(out).toEqual([a, b, 3]);
    expect(out[0]).toBe(a);
    expect(out[1]).toBe(b);
  });

  it('is idempotent: wrapping twice wraps once', () => {
    const Fake4 = makeFake4();
    expect(installConnectWrap(Fake4)).toBe(true);
    const first = Fake4.prototype.connect;
    expect(installConnectWrap(Fake4)).toBe(false);
    expect(Fake4.prototype.connect).toBe(first);
    const c = new Fake4();
    const enable = vi.spyOn(Fake4.prototype, 'monitorCommands', 'set');
    c.connect();
    expect(enable).toHaveBeenCalledTimes(1);
  });

  it('does not wrap a subclass that inherits an already wrapped connect', () => {
    const Fake4 = makeFake4();
    class Sub extends Fake4 {}
    installConnectWrap(Fake4);
    expect(installConnectWrap(Sub)).toBe(false);
    expect(hasOwn(Sub.prototype, 'connect')).toBe(false);
  });

  it('never throws into connect when preparing fails', () => {
    const onError = vi.fn();
    setSink(fakeSink({ onError }));
    class Bad extends EventEmitter {
      options = { monitorCommands: false };
      result = Promise.resolve(this);
      get monitorCommands() { return false; }
      set monitorCommands(_v: boolean) { throw new Error('setter-boom'); }
      connect() { return this.result; }
    }
    installConnectWrap(Bad);
    const c = new Bad();
    expect(c.connect()).toBe(c.result);
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'setter-boom' }));
  });

  it('never throws into connect even when onError throws too', () => {
    setSink(fakeSink({ onError: () => { throw new Error('onError-boom'); } }));
    class Bad extends EventEmitter {
      get monitorCommands() { return false; }
      set monitorCommands(_v: boolean) { throw new Error('setter-boom'); }
      connect() { return 'ok'; }
    }
    installConnectWrap(Bad);
    expect(new Bad().connect()).toBe('ok');
  });

  it('propagates what the original connect throws, unchanged', () => {
    const boom = new Error('connect-boom');
    class Thrower extends EventEmitter { connect() { throw boom; } }
    installConnectWrap(Thrower);
    expect(() => new Thrower().connect()).toThrow(boom);
  });

  it('is a pass-through when no analyser is active', () => {
    const Fake4 = makeFake4();
    installConnectWrap(Fake4);
    setSink(null);
    const c = new Fake4();
    expect(c.connect()).toBe(c.result);
    expect(c.seenAtConnect).toBe(false);
    expect(c.listenerCount('commandStarted')).toBe(0);
  });

  it('wraps a driver 3-like client (no setter): attaches, leaves monitorCommands alone', async () => {
    const Fake3 = makeFake3();
    installConnectWrap(Fake3);
    const c = new Fake3();
    await expect(c.connect()).resolves.toBe(c);
    expect(c.listenerCount('commandStarted')).toBe(1);
    expect(hasOwn(c, 'monitorCommands')).toBe(false);
  });

  it('never throws for inputs that are not a MongoClient class', () => {
    expect(installConnectWrap(undefined)).toBe(false);
    expect(installConnectWrap(null)).toBe(false);
    expect(installConnectWrap({})).toBe(false);
    expect(installConnectWrap(class NoConnect {})).toBe(false);
    const frozen = makeFake4();
    Object.freeze(frozen.prototype);
    expect(installConnectWrap(frozen)).toBe(false);
  });
});

describe('undoConnectWraps', () => {
  it('undo restores the original when the wrapper is still on top', () => {
    const Fake4 = makeFake4();
    const original = Fake4.prototype.connect;
    const before = Object.getOwnPropertyDescriptor(Fake4.prototype, 'connect');
    installConnectWrap(Fake4);
    expect(Fake4.prototype.connect).not.toBe(original);
    undoConnectWraps();
    expect(Fake4.prototype.connect).toBe(original);
    expect(Object.getOwnPropertyDescriptor(Fake4.prototype, 'connect')).toEqual(before);
    expect(CONNECT_WRAP in Fake4.prototype).toBe(false);
  });

  it('undo deletes the own property when connect was inherited', () => {
    const Fake4 = makeFake4();
    class Sub extends Fake4 {}
    expect(installConnectWrap(Sub)).toBe(true);
    expect(hasOwn(Sub.prototype, 'connect')).toBe(true);
    const c = new Sub();
    c.connect();
    expect(c.seenAtConnect).toBe(true);
    undoConnectWraps();
    expect(hasOwn(Sub.prototype, 'connect')).toBe(false);
    expect(Sub.prototype.connect).toBe(Fake4.prototype.connect);
    expect(CONNECT_WRAP in Sub.prototype).toBe(false);
  });

  it('can wrap again after an undo', () => {
    const Fake4 = makeFake4();
    installConnectWrap(Fake4);
    undoConnectWraps();
    expect(installConnectWrap(Fake4)).toBe(true);
    const c = new Fake4();
    c.connect();
    expect(c.seenAtConnect).toBe(true);
  });
});

describe('another library also patches connect (Review Focus 3)', () => {
  it('leaves a library wrapper added on top in place and becomes a pass-through', () => {
    const Fake4 = makeFake4();
    installConnectWrap(Fake4);
    const ours = Fake4.prototype.connect;
    const apm = vi.fn(function (this: InstanceType<typeof Fake4>, ...a: unknown[]) { return ours.apply(this, a as []); });
    Fake4.prototype.connect = apm as never;
    undoConnectWraps();
    expect(Fake4.prototype.connect).toBe(apm);
    const c = new Fake4();
    expect(c.connect()).toBe(c.result);
    expect(apm).toHaveBeenCalled();
    expect(c.listenerCount('commandStarted')).toBe(0);
    expect(c.seenAtConnect).toBe(false);
  });

  it('re-activates the buried wrapper on a second install instead of stacking another', () => {
    const Fake4 = makeFake4();
    installConnectWrap(Fake4);
    const ours = Fake4.prototype.connect;
    const apm = vi.fn(function (this: InstanceType<typeof Fake4>, ...a: unknown[]) { return ours.apply(this, a as []); });
    Fake4.prototype.connect = apm as never;
    undoConnectWraps();
    expect(installConnectWrap(Fake4)).toBe(false);
    expect(Fake4.prototype.connect).toBe(apm);
    const c = new Fake4();
    expect(c.connect()).toBe(c.result);
    expect(apm).toHaveBeenCalledTimes(1);
    expect(c.seenAtConnect).toBe(true);
    expect(c.listenerCount('commandStarted')).toBe(1);
    // A second install while active, with the library still on top: still no stacking.
    expect(installConnectWrap(Fake4)).toBe(false);
    expect(Fake4.prototype.connect).toBe(apm);
  });

  it('wraps over a library wrapper installed first and keeps calling it', () => {
    const Fake4 = makeFake4();
    const original = Fake4.prototype.connect;
    const apm = vi.fn(function (this: InstanceType<typeof Fake4>, ...a: unknown[]) { return original.apply(this, a as []); });
    Fake4.prototype.connect = apm as never;
    expect(installConnectWrap(Fake4)).toBe(true);
    expect(installConnectWrap(Fake4)).toBe(false);
    const c = new Fake4();
    expect(c.connect()).toBe(c.result);
    expect(apm).toHaveBeenCalledTimes(1);
    expect(c.seenAtConnect).toBe(true);
    expect(c.listenerCount('commandStarted')).toBe(1);
    const cb = vi.fn();
    expect(new Fake4().connect(cb)).toBeUndefined();
    expect(cb).toHaveBeenCalledTimes(1);
    undoConnectWraps();
    expect(Fake4.prototype.connect).toBe(apm);
  });
});

describe('monitorState / enableMonitoring', () => {
  it('monitorState reads on/off before the setter is touched, and unknown on driver 3', () => {
    const Fake4 = makeFake4();
    const Fake3 = makeFake3();
    expect(monitorState(Object.assign(new Fake4(), { options: { monitorCommands: true } }))).toBe('on');
    expect(monitorState(new Fake4())).toBe('off');
    expect(monitorState(new Fake3())).toBe('unknown');
  });

  it('monitorState never throws', () => {
    const evil = { get options(): unknown { throw new Error('x'); } };
    expect(monitorState(evil)).toBe('unknown');
    expect(monitorState(null as unknown as object)).toBe('unknown');
  });

  it('enableMonitoring sets the 4+ setter and leaves driver 3 alone', () => {
    const Fake4 = makeFake4();
    const Fake3 = makeFake3();
    const c4 = new Fake4();
    enableMonitoring(c4);
    expect(c4.monitorCommands).toBe(true);
    expect(c4.options.monitorCommands).toBe(true);
    const c3 = new Fake3();
    enableMonitoring(c3);
    expect(hasOwn(c3, 'monitorCommands')).toBe(false);
    expect('monitorCommands' in c3).toBe(false);
  });

  it('enableMonitoring never throws', () => {
    class Bad { set monitorCommands(_v: boolean) { throw new Error('boom'); } }
    expect(() => enableMonitoring(new Bad())).not.toThrow();
    expect(() => enableMonitoring(null as unknown as object)).not.toThrow();
  });
});

describe('resolvePeer', () => {
  it('resolvePeer finds the SDK devDependencies and returns null for a missing package', () => {
    expect((resolvePeer('mongoose') as { version: string }).version).toMatch(/^8\./);
    expect(resolvePeer('qa-not-installed-pkg')).toBeNull();
  });
});

describe('mongooseClients', () => {
  it('mongooseClients collects every connection client, skipping missing ones and throwing getters', () => {
    const client = {};
    const mongoose = {
      connections: [
        { getClient: () => client },
        { getClient: () => undefined },
        { getClient: () => { throw new Error('no client'); } },
      ],
    };
    expect(mongooseClients(mongoose)).toEqual([client]);
    expect(mongooseClients(mongoose)[0]).toBe(client);
  });

  it('falls back to conn.client and deduplicates shared clients', () => {
    const a = {}; const b = {};
    const mongoose = { connections: [{ client: a }, { getClient: () => a }, { getClient: () => null, client: b }, null] };
    const out = mongooseClients(mongoose);
    expect(out).toHaveLength(2);
    expect(out[0]).toBe(a);
    expect(out[1]).toBe(b);
  });

  it('returns [] for a mongoose without connections', () => {
    expect(mongooseClients({})).toEqual([]);
    const evil = { get connections(): unknown { throw new Error('x'); } };
    expect(mongooseClients(evil)).toEqual([]);
  });
});

describe('pg copies', () => {
  let FIX: string;
  const put = (rel: string, src: string): void => {
    mkdirSync(join(FIX, rel), { recursive: true });
    writeFileSync(join(FIX, rel, 'index.js'), src);
  };
  const PG = 'exports.Client = class Client { query() {} }; exports.Pool = class Pool { query() {} };';
  const at = (root: string) => (name: string): string | null => {
    try { return createRequire(join(root, 'x.js')).resolve(name); } catch { return null; }
  };
  const load = (rel: string): { Client: Function; Pool: Function } => createRequire(join(FIX, 'x.js'))(join(FIX, rel)) as { Client: Function; Pool: Function };

  beforeAll(() => {
    FIX = mkdtempSync(join(tmpdir(), 'qa-pg-copies-'));
    put('app/node_modules/pg', PG);
    put('app/node_modules/@prisma/adapter-pg/node_modules/pg', PG);
    put('app/node_modules/@prisma/adapter-pg', 'module.exports = {};');
    put('shared/node_modules/pg', PG);
    put('shared/node_modules/@prisma/adapter-pg', 'module.exports = {};');
    put('other/node_modules/pg', PG);
    const pc = join(FIX, 'prisma/node_modules/@prisma/client');
    mkdirSync(join(pc, 'dist/nested'), { recursive: true });
    writeFileSync(join(pc, 'package.json'), JSON.stringify({ name: '@prisma/client', version: '6.19.3' }));
    writeFileSync(join(pc, 'dist/index.js'), '');
    writeFileSync(join(pc, 'dist/nested/index.js'), '');
    writeFileSync(join(pc, 'dist/package.json'), JSON.stringify({ name: 'not-prisma', version: '0.0.1' }));
    mkdirSync(join(FIX, 'nopkg'), { recursive: true });
    writeFileSync(join(FIX, 'nopkg/index.js'), '');
  });
  afterAll(() => { rmSync(FIX, { recursive: true, force: true }); });

  it('Review Focus: an app with two pg copies yields both Client classes', () => {
    const r = resolvePgClients(undefined, { appEntry: at(FIX + '/app') });
    expect(r.clients).toHaveLength(2); expect(r.adapterResolved).toBe(true);
    expect(new Set(r.clients.map((c) => c.prototype)).size).toBe(2);
  });

  it("an adapter sharing the app's pg yields one class", () => {
    const r = resolvePgClients(undefined, { appEntry: at(FIX + '/shared') });
    expect(r.clients).toHaveLength(1); expect(r.adapterResolved).toBe(true);
  });

  it('a given pg module is added and deduplicated by prototype', () => {
    const app = load('app/node_modules/pg');
    expect(resolvePgClients(app, { appEntry: at(FIX + '/app') }).clients).toHaveLength(2);
    expect(resolvePgClients({ default: app }, { appEntry: at(FIX + '/app') }).clients).toHaveLength(2);
    const third = load('other/node_modules/pg');
    expect(resolvePgClients(third, { appEntry: at(FIX + '/app') }).clients).toHaveLength(3);
    expect(resolvePgClients(third, { appEntry: () => null })).toEqual({ clients: [third.Client], pools: [third.Pool], adapterResolved: false });
  });

  it('no pg anywhere yields none, and adapterResolved false', () => {
    expect(resolvePgClients(undefined, { appEntry: () => null })).toEqual({ clients: [], pools: [], adapterResolved: false });
    expect(resolvePgClients(42, { appEntry: () => { throw new Error('x'); } })).toEqual({ clients: [], pools: [], adapterResolved: false });
  });

  it('never touches pg.native', () => {
    const mod = { Client: class {}, get native(): never { throw new Error('native loaded'); } };
    expect(() => pgClientClass(mod)).not.toThrow(); expect(pgClientClass({ default: mod })).toBe(mod.Client);
    expect(pgClientClass(null)).toBeNull(); expect(pgClientClass({})).toBeNull();
  });

  it('pgClientOf takes a Pool or a Client and refuses anything else', () => {
    class Client { connectionParameters = {}; query() {} }
    expect(pgClientOf({ Client, totalCount: 0, query() {} })).toBe(Client);
    expect(pgClientOf(new Client())).toBe(Client);
    expect(pgClientOf(new EventEmitter())).toBeNull(); expect(pgClientOf(null)).toBeNull();
  });

  it('two pg copies yield both Pool classes too, deduplicated by prototype', () => {
    const r = resolvePgClients(undefined, { appEntry: at(FIX + '/app') });
    expect(r.pools).toHaveLength(2);
    expect(new Set(r.pools.map((p) => p.prototype)).size).toBe(2);
    expect(r.pools).toContain(load('app/node_modules/pg').Pool);
    expect(r.pools).toContain(load('app/node_modules/@prisma/adapter-pg/node_modules/pg').Pool);
    expect(resolvePgClients(undefined, { appEntry: at(FIX + '/shared') }).pools).toHaveLength(1);
    const app = load('app/node_modules/pg');
    expect(resolvePgClients(app, { appEntry: at(FIX + '/app') }).pools).toHaveLength(2);
  });

  it('a given pool instance adds its Pool class and its Client', () => {
    const third = load('other/node_modules/pg');
    const pool = Object.assign(Object.create((third.Pool as { prototype: object }).prototype) as object, { Client: third.Client });
    expect(resolvePgClients(pool, { appEntry: () => null })).toEqual({ clients: [third.Client], pools: [third.Pool], adapterResolved: false });
  });

  it('pgPoolClass reads Pool (CJS or default) and never touches pg.native', () => {
    const mod = { Pool: class {}, get native(): never { throw new Error('native loaded'); } };
    expect(pgPoolClass(mod)).toBe(mod.Pool); expect(pgPoolClass({ default: mod })).toBe(mod.Pool);
    expect(pgPoolClass(null)).toBeNull(); expect(pgPoolClass({})).toBeNull(); expect(pgPoolClass({ Pool: 1 })).toBeNull();
  });

  it('pgPoolOf takes a pool instance (Client + query) and refuses a client or anything else', () => {
    class Client { connectionParameters = {}; query() {} }
    class Pool { Client = Client; query() {} }
    expect(pgPoolOf(new Pool())).toBe(Pool);
    expect(pgPoolOf(new Client())).toBeNull();
    expect(pgPoolOf({ Client, query() {} })).toBeNull(); // a plain object: no class to wrap
    expect(pgPoolOf(null)).toBeNull();
    expect(pgPoolOf({ get Client(): never { throw new Error('x'); } })).toBeNull();
  });

  it('resolvePeerPath and requireFrom never throw', () => {
    expect(resolvePeerPath('definitely-not-installed-xyz')).toBeNull();
    expect(typeof resolvePeerPath('vitest')).toBe('string');
    expect(requireFrom(join(FIX, 'nope', 'x.js'), 'definitely-not-installed-xyz')).toBeNull();
    expect(requireFrom(join(FIX, 'app', 'x.js'), 'pg')).not.toBeNull();
  });

  it('prismaClientVersion: nothing resolvable gives null; a resolver that throws gives null', () => {
    expect(prismaClientVersion({ resolve: () => null })).toBeNull();
    expect(prismaClientVersion({ resolve: () => { throw new Error('x'); } })).toBeNull();
  });

  it('prismaClientVersion walks up from a subdirectory entry to the @prisma/client package.json', () => {
    const entry = join(FIX, 'prisma/node_modules/@prisma/client/dist/index.js');
    expect(prismaClientVersion({ resolve: (n) => (n === '@prisma/client' ? entry : null) })).toBe('6.19.3');
  });

  it('prismaClientVersion skips a package.json with another name on the way up', () => {
    const entry = join(FIX, 'prisma/node_modules/@prisma/client/dist/nested/index.js');
    expect(prismaClientVersion({ resolve: () => entry })).toBe('6.19.3');
  });

  it('prismaClientVersion returns null when no @prisma/client package.json is above the entry', () => {
    expect(prismaClientVersion({ resolve: () => join(FIX, 'nopkg/index.js') })).toBeNull();
  });

  it('resolvePgClients returns the adapter\'s own pg module (the app\'s when they are one copy)', () => {
    expect(resolvePgClients(undefined, { appEntry: at(FIX + '/app') }).adapterPg)
      .toBe(load('app/node_modules/@prisma/adapter-pg/node_modules/pg'));
    expect(resolvePgClients(undefined, { appEntry: at(FIX + '/shared') }).adapterPg).toBe(load('shared/node_modules/pg'));
    // Only the fixture's own chain (the plain `at` resolver would also see pnpm's NODE_PATH).
    const otherOnly = (n: string) => resolveAppPath(n, { lookup: [join(FIX, 'other/node_modules')] });
    const other = resolvePgClients(undefined, { appEntry: otherOnly });
    expect(other.adapterResolved).toBe(false);
    expect(other.adapterPg).toBeUndefined();
    expect(other.clients).toEqual([load('other/node_modules/pg').Client]);
  });

  it('resolveAppPath finds a package in the app\'s node_modules chain, and nothing else', () => {
    const pc = join(FIX, 'appprisma/node_modules/@prisma/client');
    mkdirSync(join(pc, 'dist'), { recursive: true });
    writeFileSync(join(pc, 'package.json'), JSON.stringify({ name: '@prisma/client', version: '6.19.3', main: 'dist/index.js' }));
    writeFileSync(join(pc, 'dist/index.js'), '');
    const lookup = [join(FIX, 'appprisma/sub/node_modules'), join(FIX, 'appprisma/node_modules')];
    expect(resolveAppPath('@prisma/client', { lookup })).toBe(realpathSync(join(pc, 'dist/index.js')));
    expect(prismaClientVersion({ resolve: (n) => resolveAppPath(n, { lookup }) })).toBe('6.19.3');
    expect(resolveAppPath('@prisma/client', { lookup: [join(FIX, 'app/node_modules')] })).toBeNull();
    expect(resolveAppPath('@prisma/client', { lookup: [] })).toBeNull();
  });

  it('resolveAppPath ignores a package reachable only through NODE_PATH (a hoisted transitive copy)', () => {
    const glob = join(FIX, 'global');
    const pc = join(glob, '@prisma/client');
    mkdirSync(pc, { recursive: true });
    writeFileSync(join(pc, 'package.json'), JSON.stringify({ name: '@prisma/client', version: '6.19.3' }));
    writeFileSync(join(pc, 'index.js'), '');
    const Module = createRequire(import.meta.url)('node:module') as { _initPaths(): void };
    const before = process.env.NODE_PATH;
    try {
      process.env.NODE_PATH = glob;
      Module._initPaths();
      expect(resolvePeerPath('@prisma/client')).toBe(realpathSync(join(pc, 'index.js'))); // the plain resolver is fooled
      expect(resolveAppPath('@prisma/client')).toBeNull();
      expect(resolveAppPath('pg')).not.toBeNull(); // a real devDependency of the SDK still resolves
    } finally {
      if (before === undefined) delete process.env.NODE_PATH; else process.env.NODE_PATH = before;
      Module._initPaths();
    }
    expect(resolveAppPath('@prisma/client')).toBeNull(); // nor through the NODE_PATH the test runner may set
  });

  it('Review Focus: a statement through either copy is recorded exactly once', async () => {
    const recorded: unknown[] = [];
    sqlRuntime().sink = { record: (ev) => { recorded.push(ev); } };
    try {
      const { clients } = resolvePgClients(undefined, { appEntry: at(FIX + '/app') });
      for (const C of clients) {
        (C.prototype as { query: unknown }).query = function () { return Promise.resolve({ rows: [] }); };
        expect(installPgWrap(C)).toBe(true);
      }
      for (const C of clients) await (new (C as new () => { query(s: string): Promise<unknown> })()).query('SELECT 1');
      expect(recorded).toHaveLength(2);
      for (const C of clients) expect(installPgWrap(C)).toBe(false);
      for (const C of clients) await (new (C as new () => { query(s: string): Promise<unknown> })()).query('SELECT 1');
      expect(recorded).toHaveLength(4);
    } finally {
      undoPgWraps();
      sqlRuntime().sink = null;
    }
  });
});

describe('resolveAppPath: real install layouts (Task 8 fix round 1)', () => {
  let ROOT: string;
  /** A package dir with a package.json and an index.js exporting pg-shaped classes. */
  const pkg = (dir: string, name: string): void => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version: '1.0.0', main: 'index.js' }));
    writeFileSync(join(dir, 'index.js'), 'exports.Client = class Client { query() {} }; exports.Pool = class Pool { query() {} };');
  };
  /** The SDK's built entry at `dir` (only its location matters). */
  const sdkAt = (dir: string): string => {
    mkdirSync(join(dir, 'dist'), { recursive: true });
    writeFileSync(join(dir, 'dist/index.cjs'), '');
    return join(dir, 'dist/index.cjs');
  };
  const SDK = 'node_modules/@vivekumar08/query-analyser';
  const STORE_SDK = 'node_modules/.pnpm/@vivekumar08+query-analyser@0.4.0/node_modules/@vivekumar08/query-analyser';
  const real = (p: string): string => realpathSync(p);

  beforeAll(() => { ROOT = realpathSync(mkdtempSync(join(tmpdir(), 'qa-layouts-'))); });
  afterAll(() => { rmSync(ROOT, { recursive: true, force: true }); });

  it('npm flat: the app\'s pg next to the SDK', () => {
    const app = join(ROOT, 'npm-flat');
    const moduleFile = sdkAt(join(app, SDK));
    pkg(join(app, 'node_modules/pg'), 'pg');
    expect(resolveAppPath('pg', { moduleFile, cwd: app })).toBe(real(join(app, 'node_modules/pg/index.js')));
  });

  it('standard pnpm: the peer link beside the SDK in the store', () => {
    const app = join(ROOT, 'pnpm-std');
    const moduleFile = sdkAt(join(app, STORE_SDK));
    pkg(join(app, 'node_modules/.pnpm/@vivekumar08+query-analyser@0.4.0/node_modules/pg'), 'pg');
    expect(resolveAppPath('pg', { moduleFile, cwd: app }))
      .toBe(real(join(app, 'node_modules/.pnpm/@vivekumar08+query-analyser@0.4.0/node_modules/pg/index.js')));
  });

  it('pnpm with no peer link: the app\'s own pg up the chain', () => {
    const app = join(ROOT, 'pnpm-nolink');
    const moduleFile = sdkAt(join(app, STORE_SDK));
    pkg(join(app, 'node_modules/pg'), 'pg');
    expect(resolveAppPath('pg', { moduleFile, cwd: app })).toBe(real(join(app, 'node_modules/pg/index.js')));
  });

  it('pnpm\'s hidden hoist (.pnpm/node_modules) is not the app: a sibling\'s Prisma is ignored', () => {
    const root = join(ROOT, 'pnpm-mono');
    const app = join(root, 'apps/x');
    mkdirSync(app, { recursive: true });
    const moduleFile = sdkAt(join(root, STORE_SDK));
    pkg(join(root, 'node_modules/.pnpm/node_modules/@prisma/adapter-pg'), '@prisma/adapter-pg');
    pkg(join(root, 'node_modules/.pnpm/node_modules/@prisma/client'), '@prisma/client');
    pkg(join(root, 'node_modules/.pnpm/node_modules/pg'), 'pg');
    const from = { moduleFile, cwd: app };
    expect(resolveAppPath('@prisma/adapter-pg', from)).toBeNull();
    expect(resolveAppPath('@prisma/client', from)).toBeNull();
    expect(resolveAppPath('pg', from)).toBeNull();
    const r = resolvePgClients(undefined, { appEntry: (n) => resolveAppPath(n, from) });
    expect(r).toEqual({ clients: [], pools: [], adapterResolved: false });
  });

  it('npm monorepo, SDK hoisted to the root, the app\'s pg nested, cwd = the app: found through cwd and wrapped', () => {
    const root = join(ROOT, 'npm-mono-nested');
    const app = join(root, 'apps/x');
    const moduleFile = sdkAt(join(root, SDK));
    pkg(join(app, 'node_modules/pg'), 'pg');
    const from = { moduleFile, cwd: app };
    expect(resolveAppPath('pg', from)).toBe(real(join(app, 'node_modules/pg/index.js')));
    const { clients } = resolvePgClients(undefined, { appEntry: (n) => resolveAppPath(n, from) });
    const nested = createRequire(join(app, 'x.js'))('pg') as { Client: Function };
    expect(clients).toEqual([nested.Client]);
    try {
      expect(installPgWrap(nested.Client)).toBe(true);
      expect(PG_QUERY_WRAP in nested.Client.prototype).toBe(true);
    } finally {
      undoPgWraps();
    }
  });

  it('npm monorepo with both hoisted: the root copy', () => {
    const root = join(ROOT, 'npm-mono-hoisted');
    const app = join(root, 'apps/x');
    mkdirSync(app, { recursive: true });
    const moduleFile = sdkAt(join(root, SDK));
    pkg(join(root, 'node_modules/pg'), 'pg');
    expect(resolveAppPath('pg', { moduleFile, cwd: app })).toBe(real(join(root, 'node_modules/pg/index.js')));
  });

  it('the module-relative copy wins over the cwd one', () => {
    const root = join(ROOT, 'order');
    const app = join(root, 'apps/x');
    const moduleFile = sdkAt(join(root, SDK));
    pkg(join(root, 'node_modules/pg'), 'pg');
    pkg(join(app, 'node_modules/pg'), 'pg');
    expect(resolveAppPath('pg', { moduleFile, cwd: app })).toBe(real(join(root, 'node_modules/pg/index.js')));
  });

  it('nothing installed anywhere gives null', () => {
    const app = join(ROOT, 'empty');
    const moduleFile = sdkAt(join(app, SDK));
    expect(resolveAppPath('pg', { moduleFile, cwd: app })).toBeNull();
  });
});
