import { createRequire } from 'node:module';
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

/** Module-relative createRequire (__filename, then import.meta.url), then cwd; null when not installed. Moved from resolveMongoose. */
export function resolvePeer(name: string): unknown | null {
  // Module-relative first, so the SDK finds the same copy the host's own
  // `require(name)` would, whatever the cwd. `__filename` exists in the CJS
  // build, `import.meta.url` in the ESM build; each is guarded.
  try {
    if (typeof __filename !== 'undefined') {
      return createRequire(__filename)(name) as unknown;
    }
  } catch { /* fall through to the next strategy */ }
  try {
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    if (typeof import.meta !== 'undefined' && import.meta.url) {
      return createRequire(import.meta.url)(name) as unknown;
    }
  } catch { /* fall through to the cwd fallback */ }
  try {
    return createRequire(process.cwd() + '/')(name) as unknown;
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
