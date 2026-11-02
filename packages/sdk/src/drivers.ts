import { existsSync, readFileSync } from 'node:fs';
import { createRequire, Module } from 'node:module';
import { dirname, join } from 'node:path';
import { attachClient, currentSink, hasMonitorSetter, MONITORING_OFF_WARNING } from './monitor.js';

/**
 * Driver plumbing: finding the optional peers, switching on command
 * monitoring, and the `MongoClient.prototype.connect` wrap that does it for
 * clients that connect after `init()`.
 *
 * Monitoring can only be switched on before a client connects (spike Q1):
 * the setter on driver 4+ only writes `client.options.monitorCommands`, and
 * each connection copies the flag when the topology is created. So the SDK
 * wraps the public `connect` and sets the flag right before the original
 * runs. It never touches driver internals (`client.s`, `topology`); on
 * driver 3 it neither enables monitoring nor detects whether it is on.
 *
 * Never throws into app code: every path is guarded and failures go to the
 * active sink's `onError`, which is itself guarded here.
 */

/** Any MongoClient from driver 3–7. Structural on purpose: every check is made at runtime. */
export type MongoClientLike = object;

/** On a wrapped prototype (own, non-enumerable): `{ original, wrapper, hadOwn }`. Shared across SDK copies. */
export const CONNECT_WRAP: unique symbol = Symbol.for('query-analyser.connect-wrap') as never;

export { MONITORING_OFF_WARNING };

type ConnectFn = (this: unknown, ...args: unknown[]) => unknown;

interface ConnectWrapRecord {
  original: ConnectFn;
  wrapper: ConnectFn;
  /** Whether `connect` was an own property of this prototype before the wrap. */
  hadOwn: boolean;
}

/** Wrappers created by this module copy. */
const ourWrappers = new WeakSet<ConnectFn>();
/** Prototypes whose wrapper is active (and which undoConnectWraps visits). */
const wrapped = new Set<object>();

const hasOwn = (o: object, k: PropertyKey): boolean => Object.prototype.hasOwnProperty.call(o, k);
const isObject = (v: unknown): v is object => (typeof v === 'object' || typeof v === 'function') && v !== null;

function report(e: unknown): void {
  try {
    currentSink()?.onError(e instanceof Error ? e : new Error(String(e)));
  } catch { /* onError itself failed: nothing more to do */ }
}

/** Runs `use` against a require for each strategy in turn: module-relative (`__filename`, then `import.meta.url`), then cwd. First success wins; null when all fail. */
function viaStrategies<T>(use: (req: NodeRequire) => T): T | null {
  // Module-relative first, so the SDK finds the same copy the host's own
  // `require(name)` would, whatever the cwd. `__filename` exists in the CJS
  // build, `import.meta.url` in the ESM build; each is guarded.
  try {
    if (typeof __filename !== 'undefined') {
      return use(createRequire(__filename));
    }
  } catch { /* fall through to the next strategy */ }
  try {
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    if (typeof import.meta !== 'undefined' && import.meta.url) {
      return use(createRequire(import.meta.url));
    }
  } catch { /* fall through to the cwd fallback */ }
  try {
    return use(createRequire(process.cwd() + '/'));
  } catch {
    return null;
  }
}

/** Module-relative createRequire (__filename, then import.meta.url), then cwd; null when not installed. Moved from resolveMongoose. */
export function resolvePeer(name: string): unknown | null {
  return viaStrategies((req) => req(name) as unknown);
}

/** require.resolve with the same three strategies as resolvePeer; null when not installed. */
export function resolvePeerPath(name: string): string | null {
  return viaStrategies((req) => req.resolve(name));
}

/** NODE_PATH and the other global folders: a package found only there is not one the app installed. */
function globalFolders(): Set<string> {
  try {
    const g = (Module as unknown as { globalPaths?: unknown }).globalPaths;
    return new Set(Array.isArray(g) ? g.filter((p): p is string => typeof p === 'string') : []);
  } catch {
    return new Set();
  }
}

/** pnpm's hidden hoist of every package in the workspace (`node_modules/.pnpm/node_modules`): never the app's own install. */
const PNPM_HIDDEN_HOIST = join('node_modules', '.pnpm', 'node_modules');

/** The module-relative file the SDK resolves from: `__filename` (CJS build), else `import.meta.url` (ESM build). */
function moduleFileOf(): string | null {
  try {
    if (typeof __filename !== 'undefined') return __filename;
  } catch { /* next */ }
  try {
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    if (typeof import.meta !== 'undefined' && import.meta.url) return import.meta.url;
  } catch { /* none */ }
  return null;
}

/** `createRequire(from).resolve.paths(name)`; [] on any failure. */
function lookupFrom(from: string | null, name: string): string[] {
  try {
    if (from === null) return [];
    const dirs = createRequire(from).resolve.paths(name);
    return Array.isArray(dirs) ? dirs : [];
  } catch {
    return [];
  }
}

/**
 * The node_modules directories the app's own lookup walks: the module-relative chain, then the cwd chain
 * (an SDK hoisted to a monorepo root still finds the app's nested copy), de-duplicated in that order.
 * Dropped: the global folders (NODE_PATH, ~/.node_modules…) and pnpm's hidden hoist directory.
 * `from` replaces the module file and the cwd (tests).
 */
export function appLookupDirs(name: string, from?: { moduleFile?: string; cwd?: string }): string[] {
  try {
    const globals = globalFolders();
    const out: string[] = [];
    const chains = [
      lookupFrom(from?.moduleFile ?? moduleFileOf(), name),
      lookupFrom(join(from?.cwd ?? process.cwd(), '__query_analyser__.js'), name),
    ];
    for (const chain of chains) {
      for (const d of chain) {
        if (typeof d !== 'string' || globals.has(d) || d.endsWith(PNPM_HIDDEN_HOIST) || out.includes(d)) continue;
        out.push(d);
      }
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * Like resolvePeerPath, but only for a package installed in the app's own node_modules chains (see
 * appLookupDirs): a copy reachable only through NODE_PATH, a global folder or pnpm's hidden hoist gives null.
 * `from.lookup` replaces the directories; `from.moduleFile` / `from.cwd` replace where the chains start (tests).
 * Never throws.
 */
export function resolveAppPath(name: string, from?: { lookup?: readonly string[]; moduleFile?: string; cwd?: string }): string | null {
  try {
    for (const dir of from?.lookup ?? appLookupDirs(name, from)) {
      if (!existsSync(join(dir, name))) continue;
      try {
        // Resolve from the directory that owns this node_modules, so this copy is the first one found.
        return createRequire(join(dirname(dir), '__query_analyser__.js')).resolve(name);
      } catch {
        return null; // installed here but not loadable: the app could not use it either
      }
    }
    return null;
  } catch {
    return null;
  }
}

/** createRequire(fromFile)(name); null on any failure. */
export function requireFrom(fromFile: string, name: string): unknown | null {
  try {
    return createRequire(fromFile)(name) as unknown;
  } catch {
    return null;
  }
}

/** `mod[name]` or `mod.default[name]` when it is a function; never reads `.native`. */
function pgExport(mod: unknown, name: 'Client' | 'Pool'): Function | null {
  try {
    if (!isObject(mod)) return null;
    const direct = (mod as Record<string, unknown>)[name];
    if (typeof direct === 'function') return direct;
    const d = (mod as { default?: unknown }).default;
    if (isObject(d)) {
      const c = (d as Record<string, unknown>)[name];
      if (typeof c === 'function') return c;
    }
    return null;
  } catch {
    return null;
  }
}

/** The Client class of a pg module (CJS, or ESM with `default`); never reads `.native`. */
export function pgClientClass(mod: unknown): Function | null {
  return pgExport(mod, 'Client');
}

/** The Pool class of a pg module (pg's BoundPool over pg-pool; CJS, or ESM with `default`); never reads `.native`. */
export function pgPoolClass(mod: unknown): Function | null {
  return pgExport(mod, 'Pool');
}

/** A pg Pool instance (has a Client class and a query function) -> its class; anything else (a Client, a plain object) -> null. */
export function pgPoolOf(x: unknown): Function | null {
  try {
    if (!isObject(x)) return null;
    const o = x as { Client?: unknown; query?: unknown; constructor?: unknown };
    if (typeof o.Client !== 'function' || typeof o.query !== 'function') return null;
    return typeof o.constructor === 'function' && o.constructor !== Object ? o.constructor : null;
  } catch {
    return null;
  }
}

/** A pg Pool -> pool.Client; a pg Client (has connectionParameters and a query function) -> its constructor; else null. */
export function pgClientOf(x: unknown): Function | null {
  try {
    if (!isObject(x)) return null;
    const o = x as { Client?: unknown; query?: unknown; connectionParameters?: unknown; constructor?: unknown };
    if (typeof o.query !== 'function') return null;
    if (typeof o.Client === 'function') return o.Client;
    if (o.connectionParameters !== undefined && typeof o.constructor === 'function' && o.constructor !== Object) return o.constructor;
    return null;
  } catch {
    return null;
  }
}

/** Distinct Client and Pool classes, each deduplicated by prototype identity, from: `given`, the app's pg,
 *  and pg required from @prisma/adapter-pg's resolved entry file (both found only in the app's own node_modules chain). `adapterResolved` says whether that entry resolved,
 *  and `adapterPg` is the pg module it uses. Never throws. */
export function resolvePgClients(given?: unknown, from?: { appEntry?: (name: string) => string | null }): {
  clients: Function[];
  pools: Function[];
  adapterResolved: boolean;
  /** The pg module required from the adapter's entry (for pgCoversAdapter); absent when that failed. */
  adapterPg?: unknown;
} {
  const clients: Function[] = [];
  const pools: Function[] = [];
  const seen = new Set<unknown>();
  const addTo = (list: Function[]) => (C: Function | null): void => {
    try {
      if (!C) return;
      const proto = (C as { prototype?: unknown }).prototype;
      if (!isObject(proto) || seen.has(proto)) return;
      seen.add(proto);
      list.push(C);
    } catch { /* skip */ }
  };
  const add = addTo(clients);
  const addPool = addTo(pools);
  const addModule = (mod: unknown): void => { add(pgClientClass(mod)); addPool(pgPoolClass(mod)); };
  const entry = (name: string): string | null => {
    try {
      return (from?.appEntry ?? resolveAppPath)(name);
    } catch {
      return null;
    }
  };
  let adapterResolved = false;
  let adapterPg: unknown;
  try {
    if (given != null) {
      add(pgClientClass(given) ?? pgClientOf(given));
      addPool(pgPoolClass(given) ?? pgPoolOf(given));
    }
    const pgPath = entry('pg');
    if (pgPath) addModule(requireFrom(pgPath, pgPath));
    const adapterPath = entry('@prisma/adapter-pg');
    if (adapterPath) {
      adapterResolved = true;
      const mod = requireFrom(adapterPath, 'pg');
      if (mod !== null) adapterPg = mod;
      addModule(mod);
    }
  } catch { /* partial results are fine */ }
  return adapterPg === undefined ? { clients, pools, adapterResolved } : { clients, pools, adapterResolved, adapterPg };
}

/** The installed @prisma/client version (package.json found by walking up from its resolved entry), or null. */
export function prismaClientVersion(from?: { resolve?: (name: string) => string | null }): string | null {
  try {
    let dir = dirname((from?.resolve ?? resolvePeerPath)('@prisma/client') ?? '');
    if (dir === '.') return null;
    for (let i = 0; i < 8; i++) {
      try {
        const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { name?: unknown; version?: unknown };
        if (pkg.name === '@prisma/client') return typeof pkg.version === 'string' ? pkg.version : null;
      } catch { /* not here: go up */ }
      const up = dirname(dir);
      if (up === dir) break;
      dir = up;
    }
    return null;
  } catch {
    return null;
  }
}

/** Read before anything touches the setter: 'on' if client.options.monitorCommands === true;
 *  'off' if a monitorCommands setter exists on the prototype chain; else 'unknown' (driver 3). */
export function monitorState(client: object): 'on' | 'off' | 'unknown' {
  try {
    if (!isObject(client)) return 'unknown';
    const options = (client as { options?: unknown }).options;
    if (isObject(options) && (options as { monitorCommands?: unknown }).monitorCommands === true) return 'on';
    return hasMonitorSetter(client) ? 'off' : 'unknown';
  } catch {
    return 'unknown';
  }
}

/** Sets client.monitorCommands = true when a setter exists; otherwise does nothing. Never throws. */
export function enableMonitoring(client: object): void {
  try {
    if (!isObject(client) || !hasMonitorSetter(client)) return;
    (client as { monitorCommands?: boolean }).monitorCommands = true;
  } catch (e) {
    report(e);
  }
}

function recordOf(proto: object): ConnectWrapRecord | null {
  if (!hasOwn(proto, CONNECT_WRAP)) return null;
  const r = (proto as Record<PropertyKey, unknown>)[CONNECT_WRAP];
  return isObject(r) ? (r as ConnectWrapRecord) : null;
}

/** True when `fn` is an SDK wrapper: ours, or one recorded by any SDK copy on the prototype chain. */
function isSdkWrapper(proto: object, fn: unknown): boolean {
  if (ourWrappers.has(fn as ConnectFn)) return true;
  for (let p: object | null = proto; p; p = Object.getPrototypeOf(p) as object | null) {
    if (recordOf(p)?.wrapper === fn) return true;
  }
  return false;
}

/** Wraps MongoClient.prototype.connect once. True when it was newly wrapped now. */
export function installConnectWrap(MongoClient: unknown): boolean {
  try {
    if (typeof MongoClient !== 'function') return false;
    const proto = (MongoClient as { prototype?: unknown }).prototype;
    if (!isObject(proto)) return false;

    const existing = recordOf(proto);
    if (existing) {
      // Already wrapped. If the wrapper is ours and was buried under another
      // library's patch by an earlier undo, switch it back on rather than
      // stacking a second one.
      if (ourWrappers.has(existing.wrapper)) wrapped.add(proto);
      return false;
    }

    const original = (proto as { connect?: unknown }).connect;
    if (typeof original !== 'function') return false;
    // Inherits a connect an SDK copy already wrapped (a subclass of a wrapped client).
    if (isSdkWrapper(proto, original)) return false;

    const ownDesc = Object.getOwnPropertyDescriptor(proto, 'connect');
    const hadOwn = ownDesc !== undefined;
    const orig = original as ConnectFn;

    const wrapper = function connect(this: unknown, ...args: unknown[]): unknown {
      if (wrapped.has(proto) && currentSink()) {
        try {
          if (isObject(this)) {
            enableMonitoring(this);
            attachClient(this);
          }
        } catch (e) {
          report(e);
        }
      }
      return orig.apply(this, args);
    } as ConnectFn;
    ourWrappers.add(wrapper);

    Object.defineProperty(proto, 'connect', {
      value: wrapper,
      writable: ownDesc?.writable ?? true,
      enumerable: ownDesc?.enumerable ?? false,
      configurable: ownDesc?.configurable ?? true,
    });
    const record: ConnectWrapRecord = { original: orig, wrapper, hadOwn };
    try {
      Object.defineProperty(proto, CONNECT_WRAP, { value: record, enumerable: false, writable: false, configurable: true });
    } catch (e) {
      if (hadOwn) Object.defineProperty(proto, 'connect', ownDesc);
      else delete (proto as { connect?: unknown }).connect;
      throw e;
    }
    wrapped.add(proto);
    return true;
  } catch (e) {
    report(e);
    return false;
  }
}

/** For each prototype this module wrapped: restore the original if its wrapper is still on top (delete the own property if connect was inherited); otherwise leave the wrapper as a pass-through. */
export function undoConnectWraps(): void {
  for (const proto of wrapped) {
    try {
      const record = recordOf(proto);
      if (!record) continue;
      const desc = Object.getOwnPropertyDescriptor(proto, 'connect');
      if (!desc || desc.value !== record.wrapper) continue; // another patch is on top: leave it (we are now inert)
      if (record.hadOwn) {
        Object.defineProperty(proto, 'connect', { ...desc, value: record.original });
      } else {
        delete (proto as { connect?: unknown }).connect;
      }
      delete (proto as Record<PropertyKey, unknown>)[CONNECT_WRAP];
    } catch (e) {
      report(e);
    }
  }
  wrapped.clear();
}

/** getClient?.() ?? client for each of mongoose.connections; falsy clients and throwing getters skipped; deduplicated. */
export function mongooseClients(mongoose: object): object[] {
  const out: object[] = [];
  let connections: unknown;
  try {
    connections = (mongoose as { connections?: unknown }).connections;
  } catch {
    return out;
  }
  if (!Array.isArray(connections)) return out;
  for (const conn of connections as unknown[]) {
    try {
      if (!isObject(conn)) continue;
      const c = conn as { getClient?: () => unknown; client?: unknown };
      const client = c.getClient?.() ?? c.client;
      if (isObject(client) && !out.includes(client)) out.push(client);
    } catch { /* a throwing getter: skip this connection */ }
  }
  return out;
}
