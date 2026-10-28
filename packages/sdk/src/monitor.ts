import { CAPTURED_COMMANDS, isIgnoredDatabase, mapCommand } from './command-map.js';
import { shapeOf, type CapturedShape } from './capture.js';
import type { Aggregator, Occurrence } from './aggregator.js';

/**
 * Per-client command monitor. Pairs `commandStarted` with
 * `commandSucceeded` / `commandFailed` by `requestId` (one map per client:
 * request ids come from a counter per driver copy, shared by its clients),
 * and ties each `getMore` to the cursor its `find` / `aggregate` opened.
 *
 * Never throws into the driver: every listener body is guarded and failures
 * go to `sink.onError`. Privacy: the start's command reference lives only
 * until its end arrives or the entry is evicted; of the reply, only
 * `cursor.id` is read, and nothing of it is kept but its string form in a key.
 */

export interface MonitorSink {
  aggregator: Aggregator;
  thresholdMs: number;
  onError(e: Error): void;                 // already safe to call
  isDisabled(): boolean;
  captureRawSample(): boolean;
  resolveModel(database: string, collection: string, filter: unknown): string;
}

export const MAX_IN_FLIGHT = 2_000;
export const MAX_IN_FLIGHT_AGE_MS = 600_000;
export const MAX_CURSORS = 2_000;
export const MAX_CURSOR_IDLE_MS = 600_000;

const ATTACHED = Symbol.for('query-analyser.client-attached');

interface InFlight {
  startedAt: number;
  commandName: string;
  database: string;
  /** Dropped (with the entry) on end or eviction. Undefined for insert and getMore. */
  command: Record<string, unknown> | undefined;
  /** insert only: the collection name, instead of the command. */
  collection?: string;
  connectionId: unknown;
  /** getMore only. */
  cursorKey?: string;
}

interface OpenCursor {
  shape: CapturedShape;
  occurrence: Occurrence | null;
  lastUsed: number;
}

interface ClientState {
  inFlight: Map<unknown, InFlight>;
  cursors: Map<string, OpenCursor>;
}

interface EventEmitterLike {
  on(event: string, listener: (event: unknown) => void): unknown;
}

const states = new WeakMap<object, ClientState>();
let sink: MonitorSink | null = null;

export function setSink(next: MonitorSink | null): void {
  sink = next;
}

export function currentSink(): MonitorSink | null {
  return sink;
}

/** A finite d ≥ 0 → Math.round(d), else null. */
export function toDurationMs(d: unknown): number | null {
  return typeof d === 'number' && Number.isFinite(d) && d >= 0 ? Math.round(d) : null;
}

/** Test seam. */
export function clientStats(client: object): { inFlight: number; cursors: number } | null {
  const st = states.get(client);
  return st ? { inFlight: st.inFlight.size, cursors: st.cursors.size } : null;
}

function report(s: MonitorSink | null, e: unknown): void {
  try {
    s?.onError(e instanceof Error ? e : new Error(String(e)));
  } catch {
    // onError is meant to be safe; never let it escape either.
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function evictOlderThan<V>(map: Map<unknown, V>, cutoff: number, at: (v: V) => number): void {
  for (const [k, v] of map) {
    if (at(v) >= cutoff) break;
    map.delete(k);
  }
}

function evictOldest(map: Map<unknown, unknown>, max: number): void {
  while (map.size >= max) {
    const first = map.keys().next();
    if (first.done) return;
    map.delete(first.value);
  }
}

function evictCursors(cursors: Map<string, OpenCursor>, now: number): void {
  evictOlderThan(cursors as Map<unknown, OpenCursor>, now - MAX_CURSOR_IDLE_MS, (c) => c.lastUsed);
}

function onStarted(state: ClientState, ev: unknown): void {
  const s = sink;
  try {
    if (!s || s.isDisabled() || !isRecord(ev)) return;
    const now = Date.now();
    evictOlderThan(state.inFlight, now - MAX_IN_FLIGHT_AGE_MS, (e) => e.startedAt);
    evictCursors(state.cursors, now);

    const commandName = ev.commandName;
    const database = ev.databaseName;
    const command = ev.command;
    if (typeof commandName !== 'string' || typeof database !== 'string' || !isRecord(command)) return;

    if (commandName === 'getMore') {
      evictOldest(state.inFlight, MAX_IN_FLIGHT);
      state.inFlight.set(ev.requestId, {
        startedAt: now,
        commandName,
        database,
        command: undefined,
        connectionId: ev.connectionId,
        cursorKey: `${database}.${String(command.collection)}#${String(command.getMore)}`,
      });
      return;
    }

    if (commandName === 'killCursors') {
      const ids = command.cursors;
      if (Array.isArray(ids)) {
        for (const id of ids) state.cursors.delete(`${database}.${String(command.killCursors)}#${String(id)}`);
      }
      return;
    }

    if (!CAPTURED_COMMANDS.has(commandName)) return;
    if (commandName !== 'bulkWrite' && isIgnoredDatabase(database)) return;

    evictOldest(state.inFlight, MAX_IN_FLIGHT);
    const entry: InFlight =
      commandName === 'insert'
        ? { startedAt: now, commandName, database, command: undefined, connectionId: ev.connectionId,
            collection: typeof command.insert === 'string' ? command.insert : '' }
        : { startedAt: now, commandName, database, command, connectionId: ev.connectionId };
    state.inFlight.set(ev.requestId, entry);
  } catch (e) {
    report(s, e);
  }
}

function onEnded(state: ClientState, ev: unknown, failed: boolean): void {
  const s = sink;
  try {
    if (!isRecord(ev)) return;
    // Take and drop the entry first, so the command reference never outlives its end.
    const entry = state.inFlight.get(ev.requestId);
    if (!entry) return;
    state.inFlight.delete(ev.requestId);

    if (!s || s.isDisabled()) return;
    if (
      entry.connectionId !== undefined &&
      ev.connectionId !== undefined &&
      String(entry.connectionId) !== String(ev.connectionId)
    ) {
      return;
    }
    const d = toDurationMs(ev.duration);
    if (d === null) return;
    const replyCursorId = failed ? 'undefined' : cursorIdOf(ev.reply);

    if (entry.commandName === 'getMore') {
      onGetMoreEnded(state, s, entry.cursorKey ?? '', d, failed, replyCursorId);
      return;
    }

    const command = entry.commandName === 'insert' ? { insert: entry.collection } : entry.command ?? {};
    const statements = mapCommand(entry.commandName, entry.database, command);
    entry.command = undefined;

    const counted = d >= s.thresholdMs;
    const live =
      !failed &&
      (entry.commandName === 'find' || entry.commandName === 'aggregate') &&
      statements.length === 1 &&
      replyCursorId !== '0' &&
      replyCursorId !== 'undefined';
    if (!counted && !live) return;

    const seen = new Set<string>();
    let lastShape: CapturedShape | null = null;
    let lastOcc: Occurrence | null = null;
    for (const st of statements) {
      const shape = shapeOf(st, s.resolveModel(st.database, st.collection, st.filter));
      if (seen.has(shape.sig.hash)) continue;
      seen.add(shape.sig.hash);
      lastShape = shape;
      lastOcc = null;
      if (counted) {
        const raw = s.captureRawSample() ? st.sampleInput ?? undefined : undefined;
        lastOcc = s.aggregator.add(shape.sig, d, shape.sample, raw, shape.collection);
      }
    }

    if (live && lastShape) {
      const st = statements[0]!;
      const now = Date.now();
      evictCursors(state.cursors, now);
      evictOldest(state.cursors as Map<unknown, unknown>, MAX_CURSORS);
      state.cursors.set(`${st.database}.${st.collection}#${replyCursorId}`, {
        shape: lastShape,
        occurrence: lastOcc,
        lastUsed: now,
      });
    }
  } catch (e) {
    report(s, e);
  }
}

function cursorIdOf(reply: unknown): string {
  if (!isRecord(reply)) return 'undefined';
  const cursor = reply.cursor;
  return isRecord(cursor) ? String(cursor.id) : 'undefined';
}

function onGetMoreEnded(
  state: ClientState,
  s: MonitorSink,
  key: string,
  d: number,
  failed: boolean,
  replyCursorId: string,
): void {
  const cursor = state.cursors.get(key);
  if (!cursor) return;
  // Touch: re-insert so the map's order stays least-recently-used first.
  state.cursors.delete(key);
  cursor.lastUsed = Date.now();
  const ends = failed || replyCursorId === '0';
  if (!ends) state.cursors.set(key, cursor);

  if (cursor.occurrence && s.aggregator.extend(cursor.occurrence, d)) return;
  if (d >= s.thresholdMs) {
    const { shape } = cursor;
    cursor.occurrence = s.aggregator.add(shape.sig, d, shape.sample, undefined, shape.collection);
  }
}

/** Adds the three listeners once per client (guard: Symbol.for('query-analyser.client-attached')). True when added now. */
export function attachClient(client: object): boolean {
  try {
    if (!isRecord(client) || typeof (client as Partial<EventEmitterLike>).on !== 'function') return false;
    const tagged = client as Record<PropertyKey, unknown>;
    if (tagged[ATTACHED] === true) return false;
    Object.defineProperty(client, ATTACHED, { value: true, enumerable: false, configurable: true });
    const state: ClientState = { inFlight: new Map(), cursors: new Map() };
    states.set(client, state);
    const emitter = client as unknown as EventEmitterLike;
    emitter.on('commandStarted', (ev) => onStarted(state, ev));
    emitter.on('commandSucceeded', (ev) => onEnded(state, ev, false));
    emitter.on('commandFailed', (ev) => onEnded(state, ev, true));
    return true;
  } catch (e) {
    report(sink, e);
    return false;
  }
}
