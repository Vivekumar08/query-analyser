import { createHash } from 'node:crypto';
import { hostname } from 'node:os';
import { bucketOf, encryptSample, importSamplePublicKey } from '@query-analyser/contract/runtime';
import type { EncryptedSample, IngestItem, IngestPayload } from './types.js';
import { Aggregator, type AggregatedItem } from './aggregator.js';
import { attachClient, claimMonitoringWarning, currentSink, setSink, type MonitorSink } from './monitor.js';
import { createModelResolver } from './model-registry.js';
import {
  enableMonitoring,
  installConnectWrap,
  monitorState,
  mongooseClients,
  prismaClientVersion,
  resolveAppPath,
  resolvePeer,
  resolvePgClients,
  undoConnectWraps,
  MONITORING_OFF_WARNING,
  type MongoClientLike,
} from './drivers.js';
import { installPgPoolWrap, installPgWrap, undoPgWraps } from './integrations/pg.js';
import { appHelperPresent, ensurePrismaHook, installPrismaHook, pgCoversAdapter, undoPrismaHook } from './integrations/prisma.js';
import { sqlRuntime } from './sql/context.js';
import { createSqlSink, type SqlSink } from './sql/core.js';
import { toWireItem } from './wire-item.js';
import { createTransport, planChunks, MAX_CHUNK_BYTES } from './transport.js';

// Minor fix 7: hand-typed and previously could drift from package.json.
// `__SDK_VERSION__` is a build-time constant substituted both by tsup's
// `define` (see tsup.config.ts) and by vitest's `define` (see
// vitest.config.ts), each sourced from package.json's own `version` field —
// so the published dist and the test run both see the real value and the
// two cannot diverge silently.
declare const __SDK_VERSION__: string;
export const SDK_VERSION: string = typeof __SDK_VERSION__ !== 'undefined' ? __SDK_VERSION__ : '0.0.0';
const DEFAULT_ENDPOINT = 'https://ingest.query-analyser.dev/v1/ingest';
// Critical 2: mirrors `items.max(5000)` in @query-analyser/contract's
// ingestPayloadSchema. Duplicated as a literal (not imported) because the
// contract package is dev-only for the SDK — see types.ts for why the SDK
// never imports runtime values from it.
const MAX_SIGNATURES = 5000;

function resolveMaxSignatures(requested: number | undefined, onError: (e: Error) => void): number {
  const value = requested ?? MAX_SIGNATURES;
  if (value > MAX_SIGNATURES) {
    onError(new Error(
      `query-analyser: maxSignatures (${value}) exceeds the ingest API's limit of ${MAX_SIGNATURES}; clamping to ${MAX_SIGNATURES}`,
    ));
    return MAX_SIGNATURES;
  }
  return value;
}

// Decision 17, verbatim.
const UNRESOLVED_WARNING =
  'query-analyser: none of mongoose, mongodb, pg or @prisma/client could be resolved and no client was given; pass init({ mongoose }), init({ mongoClient }) or init({ pg })';

// Decision 18, verbatim.
const engineWarning = (version: string): string =>
  `query-analyser: @prisma/client ${version} without @prisma/adapter-pg runs its SQL inside the query engine, which the SDK captures only when your app already enables Prisma tracing. Use @prisma/adapter-pg, or Prisma 7, to capture these queries.`;

const SAMPLE_RATE_WARNING = 'query-analyser: sql.sampleRate must be a number greater than 0 and at most 1; using 1';
const DEFAULT_THRESHOLD_MS = 100;
const THRESHOLD_WARNING = `query-analyser: thresholdMs must be a whole number of milliseconds, 0 or more; using ${DEFAULT_THRESHOLD_MS}`;

/** `sql.sampleRate`, validated once here so the sink never reports per statement. Invalid -> reported, 1. */
function resolveSampleRate(requested: unknown, report: (e: Error) => void): number {
  if (requested === undefined) return 1;
  if (typeof requested === 'number' && Number.isFinite(requested) && requested > 0 && requested <= 1) return requested;
  report(new Error(SAMPLE_RATE_WARNING));
  return 1;
}

/**
 * `thresholdMs`, as the ingest API accepts it (a non-negative integer). null/undefined -> 100; a finite
 * fraction >= 0 is rounded (no warning); anything else (negative, NaN, Infinity, not a number) -> reported, 100.
 */
function resolveThresholdMs(requested: unknown, report: (e: Error) => void): number {
  if (requested === undefined || requested === null) return DEFAULT_THRESHOLD_MS;
  if (typeof requested === 'number' && Number.isFinite(requested) && requested >= 0) return Math.round(requested);
  report(new Error(THRESHOLD_WARNING));
  return DEFAULT_THRESHOLD_MS;
}

/** `options.sql`, read once and guarded (a throwing getter means the defaults). */
function readSqlOptions(options: InitOptions): { sampleRate: unknown; maskIdentifiers: boolean } {
  try {
    const o: unknown = options.sql;
    if (typeof o !== 'object' || o === null) return { sampleRate: undefined, maskIdentifiers: false };
    const { sampleRate, maskIdentifiers } = o as { sampleRate?: unknown; maskIdentifiers?: unknown };
    return { sampleRate, maskIdentifiers: maskIdentifiers === true };
  } catch {
    return { sampleRate: undefined, maskIdentifiers: false };
  }
}

/** Major version of a semver string, or null. */
function majorOf(version: string | null): number | null {
  const m = version === null ? null : /^(\d+)\./.exec(version);
  return m ? Number(m[1]) : null;
}

/**
 * Wraps the Client and Pool classes of a `pg` module, Pool or Client (`instrument()` and repeated `init()`).
 * With `remember`, the classes are kept on the runtime so every later `init()` wraps them again. Never throws.
 */
function wrapPg(x: unknown, remember = false): boolean {
  try {
    // Only what was given: a module, a Pool (and its Client) or a Client. Nothing is resolved here.
    const { clients, pools } = resolvePgClients(x, { appEntry: () => null });
    for (const C of clients) installPgWrap(C);
    for (const P of pools) installPgPoolWrap(P);
    if (remember) rememberInstrumented(clients, pools);
    return clients.length > 0 || pools.length > 0;
  } catch {
    return false;
  }
}

/** The classes instrument() was given, as plain arrays (a runtime from another SDK copy may hold anything). */
function instrumentedPg(): { clients: Function[]; pools: Function[] } {
  try {
    const seen: unknown = sqlRuntime().instrumentedPg;
    if (typeof seen !== 'object' || seen === null) return { clients: [], pools: [] };
    const { clients, pools } = seen as { clients?: unknown; pools?: unknown };
    const fns = (v: unknown): Function[] => (Array.isArray(v) ? v.filter((f): f is Function => typeof f === 'function') : []);
    return { clients: fns(clients), pools: fns(pools) };
  } catch {
    return { clients: [], pools: [] };
  }
}

function rememberInstrumented(clients: Function[], pools: Function[]): void {
  try {
    const seen = instrumentedPg();
    for (const C of clients) if (!seen.clients.includes(C)) seen.clients.push(C);
    for (const P of pools) if (!seen.pools.includes(P)) seen.pools.push(P);
    sqlRuntime().instrumentedPg = seen;
  } catch { /* never throws */ }
}

const defaultOnError = (e: Error): void => { process.stderr.write(`[query-analyser] ${e.message}\n`); };

/**
 * Switches monitoring on (for a later connect) and attaches the listeners,
 * once per client. Warns first if monitoring is off, since a client that is
 * already connected will not pick the flag up. A client whose flag reads on
 * but whose topology ignored it (set on a re-connect of a connected client)
 * is caught later by the monitor's probe. At most one warning per client,
 * across init() calls, instrument() and the probe. Never throws.
 */
function watchClient(client: MongoClientLike, report: (e: Error) => void): void {
  try {
    if (monitorState(client) === 'off' && claimMonitoringWarning(client)) {
      report(new Error(MONITORING_OFF_WARNING));
    }
    enableMonitoring(client);
    attachClient(client);
  } catch (err) {
    try { report(err instanceof Error ? err : new Error(String(err))); } catch { /* never throw from reporting */ }
  }
}

export interface InitOptions {
  apiKey: string;
  app: string;
  endpoint?: string;
  env?: string;
  thresholdMs?: number;
  flushIntervalMs?: number;
  maxSignatures?: number;
  enabled?: boolean;
  /** The app's mongoose; resolved from the app's own install when omitted. */
  mongoose?: object;
  /** Clients to capture directly: one the SDK can't reach, or one already connected. */
  mongoClient?: MongoClientLike | MongoClientLike[];
  fetchImpl?: typeof fetch;
  onError?: (e: Error) => void;
  /**
   * Opt-in end-to-end encrypted real-value samples: the app's sample public
   * key (base64 SPKI, P-256), typically `process.env.QA_SAMPLE_KEY`. When set,
   * the slowest occurrence of each query shape is also sent encrypted to this
   * key, so only someone with the app's passphrase can read its values. When
   * unset (or empty), payloads are exactly as without this option.
   */
  sampleKey?: string;
  /**
   * The app's `pg` module, for a copy the SDK can't resolve on its own (a bundled one). The app's own
   * `pg` and `@prisma/adapter-pg`'s are found without it.
   */
  pg?: object;
  /** PostgreSQL capture (`pg`, and Prisma through `pg` or the app's own Prisma tracing). */
  sql?: {
    /** Replace table, column, schema and database names with keyed hashes before anything leaves the process. */
    maskIdentifiers?: boolean;
    /** Fraction (0 < r <= 1, default 1) of fast, successful statements to time; slow and failed ones are always counted. */
    sampleRate?: number;
  };
}

// Distinct encryption-failure causes reported per analyser; past this, new
// causes are dropped so a pathological stream of errors can't grow memory.
const MAX_REPORTED_SAMPLE_ERRORS = 16;
// Total `ct` characters of all envelopes in one flush (C5-2): ~1 MiB of
// incompressible base64 keeps the body well under the ingest API's 2 MiB limit.
// C5-3 amends C5-2: the budget is charged each envelope's full JSON length
// (`,"encryptedSample":{"v":1,"epk":…,"iv":…,"ct":…}`), not just `ct`. The
// body size itself is bounded separately by splitting into chunks.
const MAX_ENVELOPE_JSON_CHARS_PER_FLUSH = 1_048_576;
const ENVELOPE_KEY_JSON = ',"encryptedSample":';
// Everything but `ct` in an envelope: a P-256 point (88 base64 chars), a
// 12-byte IV (16), the keys and punctuation.
const ENVELOPE_FIXED_JSON_CHARS =
  ENVELOPE_KEY_JSON.length + JSON.stringify({ v: 1, epk: 'x'.repeat(88), iv: 'x'.repeat(16), ct: '' }).length;

export interface Analyser {
  flush(): Promise<void>;
  shutdown(): Promise<void>;
  readonly installedModels: number;
}

/**
 * Test-only extension of Analyser. `_aggregator` lets tests seed content
 * into the aggregator directly (there is no live mongoose connection in
 * these unit tests to produce real queries) without adding anything to the
 * public Analyser surface.
 */
type InternalAnalyser = Analyser & { _stop(): void; _aggregator: Aggregator };

let active: InternalAnalyser | null = null;
let activeOptions: { apiKey: string; app: string } | null = null;
/** False while the active instance is the `enabled: false` no-op. */
let activeEnabled = false;

/** options.mongoClient as a list of objects; never throws. */
function givenClients(given: MongoClientLike | MongoClientLike[] | undefined): object[] {
  try {
    const list: unknown[] = given === undefined ? [] : Array.isArray(given) ? given : [given];
    return list.filter((c): c is object => typeof c === 'object' && c !== null);
  } catch {
    return [];
  }
}

// Important 3: calling the returned `analyser.shutdown()` directly — the
// natural call for a TS user holding an `Analyser` — used to never clear
// module-level `active`/`activeOptions`. A later `init()` would then see
// `active` still set and hand back the SAME dead instance (timer cleared,
// context deleted, `installedModels: 0`), silently disabling instrumentation
// for the rest of the process's life. Both the instance method and the
// module-level `shutdown()` now route through this one function, guarded by
// identity so a shutdown() from a stale instance can never clobber a newer
// `init()` that has since replaced it.
function clearActiveIfSelf(self: InternalAnalyser): void {
  if (active === self) {
    active = null;
    activeOptions = null;
    activeEnabled = false;
  }
}

export function init(options: InitOptions): Analyser {
  const onError = options.onError ?? defaultOnError;

  // Minor fix: check for an existing instance before validating options, so
  // a second init() call — even one with a bad/omitted apiKey — returns the
  // live instance instead of throwing. If the new call's identity differs
  // from the one already active, warn instead of silently reusing the wrong
  // key/app — that mismatch would otherwise be a silent support ticket.
  if (active) {
    if (activeOptions && (activeOptions.apiKey !== options.apiKey || activeOptions.app !== options.app)) {
      onError(new Error(
        'query-analyser: init() was already called with different options; reusing the existing instance and ignoring the apiKey/app from this call',
      ));
    }
    // Serverless handlers often call init({ mongoClient }) on every
    // invocation with a lazily created client: watch the clients this call
    // brings (attach once, warn once per client), unless the live instance is
    // the disabled no-op.
    if (activeEnabled) {
      const report = (e: Error): void => { try { onError(e); } catch { /* never throw from reporting */ } };
      for (const client of givenClients(options.mongoClient)) watchClient(client, report);
      if (options.pg != null) wrapPg(options.pg);
    }
    return active;
  }

  if (!options.apiKey) throw new Error('query-analyser: apiKey is required');
  if (!options.app) throw new Error('query-analyser: app is required');

  // Critical 2: `ingestPayloadSchema` caps `items` at 5000. A caller-supplied
  // `maxSignatures` above that would let the aggregator produce a batch the
  // ingest API is guaranteed to 400 on — which `transport.ts` treats as
  // "unserviceable, drop it": silent, permanent data loss. Clamp instead of
  // trusting the caller, and say so once.
  const maxSignatures = resolveMaxSignatures(options.maxSignatures, onError);

  if (options.enabled === false) {
    // eslint-disable-next-line prefer-const
    let noop: InternalAnalyser;
    noop = {
      flush: async () => {},
      // Important 3: routes through the same "clear module state only if
      // I'm still the active one" guard as the real instance below, so
      // `noop.shutdown()` (the natural call for a TS user holding the
      // returned Analyser) doesn't leave a dead no-op instance pinned as
      // `active` forever.
      async shutdown() { clearActiveIfSelf(noop); },
      installedModels: 0,
      _stop: () => {},
      _aggregator: new Aggregator(maxSignatures),
    };
    active = noop;
    activeOptions = { apiKey: options.apiKey, app: options.app };
    activeEnabled = false;
    return noop;
  }

  const reportSafely = (e: Error) => { try { onError(e); } catch { /* never throw from reporting */ } };
  // Validated once here: an invalid value is reported once and the default used, never per statement.
  const thresholdMs = resolveThresholdMs(options.thresholdMs, reportSafely);
  const sql = readSqlOptions(options);
  const sampleRate = resolveSampleRate(sql.sampleRate, reportSafely);
  const flushIntervalMs = options.flushIntervalMs ?? 10_000;
  const aggregator = new Aggregator(maxSignatures);
  const transport = createTransport({
    endpoint: options.endpoint ?? DEFAULT_ENDPOINT,
    apiKey: options.apiKey,
    fetchImpl: options.fetchImpl,
    onError,
  });

  // Sample encryption. The key is validated asynchronously (Web Crypto has no
  // sync import), so it starts 'pending': the monitor already captures raw
  // samples, and the first flush waits for the check before deciding. An
  // invalid key is reported once and turns encryption off for good — samples
  // serialised meanwhile are simply discarded, never sent.
  const sampleKey = typeof options.sampleKey === 'string' && options.sampleKey !== '' ? options.sampleKey : undefined;
  let sampleEncryption: 'off' | 'pending' | 'on' = sampleKey ? 'pending' : 'off';
  const sampleKeyCheck: Promise<void> | null = sampleKey
    ? Promise.resolve()
      .then(() => importSamplePublicKey(sampleKey))
      .then(
        () => { sampleEncryption = 'on'; },
        () => {
          sampleEncryption = 'off';
          reportSafely(new Error(
            'query-analyser: sampleKey is not a valid sample public key (base64 SPKI, P-256); encrypted samples are off for this process',
          ));
        },
      )
    : null;
  const reportedSampleErrors = new Set<string>();
  const reportSampleError = (err: unknown) => {
    const cause = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    if (reportedSampleErrors.has(cause) || reportedSampleErrors.size >= MAX_REPORTED_SAMPLE_ERRORS) return;
    reportedSampleErrors.add(cause);
    reportSafely(new Error(`query-analyser: could not encrypt a sample (${cause}); sending the item without it`));
  };

  const encryptSampleText = async (key: string, text: string): Promise<EncryptedSample | null> => {
    try {
      return await encryptSample(key, text);
    } catch (err) {
      reportSampleError(err);
      return null;
    }
  };

  // Buffered items -> wire items. `sampleText` never goes on the wire.
  // Without encryption the wire items are exactly what they were before this
  // feature (same keys, same order — no `encryptedSample` key at all).
  // Built from an explicit allowlist of wire keys — never a rest spread of
  // the buffered item — so in-memory-only fields (the plaintext `sampleText`)
  // can never reach the wire, whatever is added to AggregatedItem later.
  const withoutSampleText = (items: AggregatedItem[]): IngestItem[] => items.map(toWireItem);

  // Ciphertext does not compress, and the ingest API rejects bodies over
  // 2 MiB — which would drop the whole batch, timing data included. So the
  // envelopes in one flush share a fixed budget; the slowest items get
  // theirs first, and items past the budget send `encryptedSample: null`.
  // Items are encrypted one at a time so the batch never monopolises the
  // event loop.
  const toEncryptedWireItems = async (items: AggregatedItem[]): Promise<IngestItem[]> => {
    if (sampleKeyCheck) await sampleKeyCheck;
    if (sampleEncryption !== 'on' || sampleKey === undefined) return withoutSampleText(items);
    const envelopes = new Array<EncryptedSample | null>(items.length).fill(null);
    const slowestFirst = items.map((_, i) => i).sort((a, b) => items[b]!.maxMs - items[a]!.maxMs);
    let budget = MAX_ENVELOPE_JSON_CHARS_PER_FLUSH;
    for (const i of slowestFirst) {
      const text = items[i]!.sampleText;
      if (text === undefined) continue;
      // ct = base64(plaintext bytes + 16-byte GCM tag): known before encrypting.
      const ctChars = Math.ceil((Buffer.byteLength(text, 'utf8') + 16) / 3) * 4;
      if (ctChars + ENVELOPE_FIXED_JSON_CHARS > budget) continue;
      const envelope = await encryptSampleText(sampleKey, text);
      if (envelope) {
        envelopes[i] = envelope;
        budget -= ENVELOPE_KEY_JSON.length + JSON.stringify(envelope).length;
      }
    }
    return items.map((item, i) => ({ ...toWireItem(item), encryptedSample: envelopes[i] ?? null }));
  };

  let disabled = false;
  let backoffUntil = 0;
  // Fix round 2: was a boolean `flushing` guard. That made a timer-driven
  // flush and a shutdown()-driven flush mutually exclusive but not joined —
  // shutdown() could resolve while the real network call from an in-flight
  // flush was still pending, dropping the last window on process.exit().
  // Tracking the in-flight promise lets every caller (timer, shutdown, a
  // customer's own flush()) await the SAME send instead of one bailing out.
  let inFlight: Promise<void> | null = null;

  // Driver layer. Queries are captured from command monitoring on each
  // MongoClient; mongoose (when there is one) is only read to name models.
  // Never throws: every step below is guarded and failures go to onError.
  let mg: object | null = null;
  let mongoFound = true; // a failure while looking means: don't claim nothing was found
  try {
    mg = options.mongoose ?? (resolvePeer('mongoose') as object | null);
  } catch (err) {
    reportSafely(err instanceof Error ? err : new Error(String(err)));
  }
  const resolver = createModelResolver(mg);
  const sink: MonitorSink = {
    aggregator,
    thresholdMs,
    onError: reportSafely,
    isDisabled: () => disabled,
    captureRawSample: () => sampleEncryption !== 'off',
    resolveModel: (database, collection, filter) => resolver.resolve(database, collection, filter),
  };
  setSink(sink);

  try {
    const drv = resolvePeer('mongodb') as { MongoClient?: unknown } | null;
    let mgMongoClient: unknown;
    try {
      mgMongoClient = (mg as { mongo?: { MongoClient?: unknown } } | null)?.mongo?.MongoClient;
    } catch (err) {
      reportSafely(err instanceof Error ? err : new Error(String(err)));
    }
    // Wrap connect so clients that connect from now on get monitoring
    // switched on before their topology is created. Deduplicated by identity
    // (mongoose.mongo is usually the very same driver module).
    const ctors = new Set<unknown>([drv?.MongoClient, mgMongoClient]);
    for (const ctor of ctors) {
      if (typeof ctor === 'function') installConnectWrap(ctor);
    }

    // Clients that exist already: mongoose's connections, and any passed in.
    const given = givenClients(options.mongoClient);
    const clients = new Set<object>([...(mg ? mongooseClients(mg) : []), ...given]);
    for (const client of clients) watchClient(client, reportSafely);

    mongoFound = mg !== null || drv !== null || given.length > 0;
  } catch (err) {
    reportSafely(err instanceof Error ? err : new Error(String(err)));
  }

  // SQL layers: pg (every copy the SDK can reach, plus options.pg) and the Prisma tracing hook.
  // Guarded on its own, so a failure here never undoes the Mongo layer, and vice versa.
  let sqlSink: SqlSink | null = null;
  let sqlFound = true; // as mongoFound
  try {
    const rt = sqlRuntime();
    sqlSink = createSqlSink({
      aggregator,
      thresholdMs,
      sampleRate,
      maskIdentifiers: sql.maskIdentifiers,
      // Keys identifier masking, stable across processes of one app (rotating the key changes masked names).
      maskKey: createHash('sha256').update('qa-mask:' + options.apiKey).digest(),
      isDisabled: () => disabled,
      onError: reportSafely,
    });
    rt.sink = sqlSink;

    const { clients: pgClients, pools: pgPools, adapterResolved, adapterPg } = resolvePgClients(options.pg);
    for (const C of pgClients) installPgWrap(C);
    for (const P of pgPools) installPgPoolWrap(P);
    // A bundled pg given to instrument() before an earlier shutdown() is wrapped again.
    const bundled = instrumentedPg();
    for (const C of bundled.clients) installPgWrap(C);
    for (const P of bundled.pools) installPgPoolWrap(P);
    rt.prismaAdapterResolved = adapterResolved;
    // After the wraps: whether the adapter's own pg is now one of the wrapped copies.
    rt.pgCoversPrismaAdapter = pgCoversAdapter(adapterResolved, adapterPg);
    installPrismaHook();

    // Only an @prisma/client in the app's own node_modules counts (not one reachable through NODE_PATH).
    const prismaVersion = prismaClientVersion({ resolve: resolveAppPath });
    const major = majorOf(prismaVersion);
    if (prismaVersion !== null && (major === 5 || major === 6) && !adapterResolved && !appHelperPresent() && rt.engineWarningReported !== true) {
      rt.engineWarningReported = true;
      reportSafely(new Error(engineWarning(prismaVersion)));
    }
    sqlFound = pgClients.length > 0 || options.pg != null || prismaVersion !== null || resolveAppPath('@prisma/client') !== null;
  } catch (err) {
    reportSafely(err instanceof Error ? err : new Error(String(err)));
  }
  if (!mongoFound && !sqlFound) reportSafely(new Error(UNRESOLVED_WARNING));
  const installedModels = resolver.modelCount();

  const doFlush = async (): Promise<void> => {
    // Fix round 3: transport.send() never rejects, but swap()/bucketOf()/
    // hostname() — or a future edit — theoretically could. flush() is
    // called fire-and-forget (`void flush()`) from the interval tick and
    // beforeExit, so an unhandled rejection here would, by default since
    // Node 15, crash the host process. The SDK's contract is that it never
    // takes the host down, so every failure must resolve, not reject.
    // Decision 16: put back any watched Prisma key the app deleted. Only while this analyser's
    // sink is live, so a flush after shutdown() never re-installs what shutdown() removed.
    try {
      if (sqlSink !== null && sqlRuntime().sink === sqlSink) ensurePrismaHook();
    } catch { /* never throws */ }
    try {
      const { items, dropped } = aggregator.swap();
      if (items.length === 0 && dropped === 0) return;

      const base: Omit<IngestPayload, 'items'> = {
        app: options.app,
        // Critical 2: `??` only falls through on null/undefined, so
        // `NODE_ENV=''` (a real thing some process managers set) sailed
        // through as `env: ''`, which `ingestPayloadSchema`'s
        // `z.string().min(1)` rejects — a 400 the transport treats as
        // "drop the batch". `||` also falls through on the empty string.
        env: options.env || process.env.NODE_ENV || 'development',
        host: hostname(),
        sdkVersion: SDK_VERSION,
        bucket: bucketOf(new Date()),
        thresholdMs,
        dropped,
      };
      // No sampleKey: stay fully synchronous up to transport.send(), as
      // before this feature.
      const wire = sampleKey === undefined ? withoutSampleText(items) : await toEncryptedWireItems(items);

      // C5-3: the ingest API rejects bodies over 2 MiB (decompressed), and a
      // rejected body is dropped whole. So one flush is POSTed as chunks of
      // at most MAX_CHUNK_BYTES each; a small batch is still exactly one
      // POST with the same payload as before.
      const { chunks, oversized } = planChunks(base, wire);
      if (oversized.length > 0) {
        reportSafely(new Error(
          `query-analyser: dropped ${oversized.length} item(s) too large for one ingest request (over ${MAX_CHUNK_BYTES} bytes of JSON)`,
        ));
      }
      for (let c = 0; c < chunks.length; c++) {
        const chunk = chunks[c]!;
        // The drop count rides on the first chunk only, so it isn't counted twice.
        const payload: IngestPayload = { ...base, dropped: c === 0 ? dropped : 0, items: chunk.map((i) => wire[i]!) };
        const result = await transport.send(payload);
        if (result.status === 'retry') {
          // This chunk and every unsent one go back into the buffer (as the
          // buffered items, sample text included) for the next flush; the
          // chunks already accepted are not re-sent.
          backoffUntil = Date.now() + result.afterMs;
          aggregator.merge(chunks.slice(c).flat().map((i) => items[i]!));
          break;
        }
        if (result.status === 'disabled') {
          disabled = true;
          onError(new Error(result.reason));
          break;
        }
      }
    } catch (err) {
      onError(err instanceof Error ? err : new Error(String(err)));
    }
  };

  // setInterval doesn't await flush(), so a send() slower than
  // flushIntervalMs could otherwise let two flushes overlap, each swap()ing
  // the buffer concurrently. A single shared in-flight promise means a
  // second caller (the timer, shutdown(), or a customer calling flush()
  // directly) joins the same send instead of racing it or silently no-oping.
  const flush = (): Promise<void> => {
    if (disabled || Date.now() < backoffUntil) return Promise.resolve();
    if (inFlight) return inFlight;
    inFlight = doFlush().finally(() => { inFlight = null; });
    return inFlight;
  };

  const timer = setInterval(() => { void flush(); }, flushIntervalMs);
  timer.unref();

  // Critical fix: do NOT install a SIGTERM listener. process.once('SIGTERM',
  // ...) with a handler that never calls process.exit() removes Node's
  // default terminate-on-SIGTERM behavior, so a host app with an open HTTP
  // server or DB pool would no longer exit on SIGTERM at all — k8s/systemd
  // would wait out the grace period and SIGKILL it. beforeExit is safe to
  // keep: it only fires once the event loop is already draining on its own.
  const onExit = () => { void flush(); };
  process.once('beforeExit', onExit);

  // eslint-disable-next-line prefer-const
  let analyser: InternalAnalyser;
  analyser = {
    flush,
    installedModels,
    async shutdown() {
      clearInterval(timer);
      process.off('beforeExit', onExit);
      // Fix round 2: the first await joins whatever flush is already in
      // flight (started by the timer or a caller) rather than racing past
      // it — shutdown() must not resolve while a real send is still
      // pending, or a customer doing `await shutdown(); process.exit(0)`
      // would exit mid-send and drop the last window. The second await
      // drains anything that arrived (via the monitor, or a test seam)
      // while that first flush was in flight, since swap() only takes what
      // existed at the moment it ran. backoffUntil is reset before each
      // await so a retry() from either flush doesn't suppress the drain.
      backoffUntil = 0;
      await flush();
      backoffUntil = 0;
      await flush();
      // Stop capturing. Attached listeners stay on their clients (they are
      // inert with no sink), and the connect wraps come off unless another
      // patch now sits on top of one. Guarded so a shutdown() racing a newer
      // init() never clears the newer sink or its wraps.
      if (currentSink() === sink) {
        setSink(null);
        undoConnectWraps();
      }
      // The same for the SQL layers: only this analyser's own sink, wraps and hook.
      try {
        const rt = sqlRuntime();
        if (sqlSink !== null && rt.sink === sqlSink) {
          rt.sink = null;
          undoPgWraps();
          undoPrismaHook();
          rt.prismaAdapterResolved = false;
          rt.pgCoversPrismaAdapter = false;
        }
      } catch (err) {
        reportSafely(err instanceof Error ? err : new Error(String(err)));
      }
      // Important 3: see clearActiveIfSelf's comment above `active`.
      clearActiveIfSelf(analyser);
    },
    _stop() { clearInterval(timer); },
    _aggregator: aggregator,
  };

  active = analyser;
  activeOptions = { apiKey: options.apiKey, app: options.app };
  activeEnabled = true;
  return analyser;
}

/**
 * Captures queries from this client: for a client the SDK can't reach on its
 * own (a bundled or nested driver copy), or one connected before init().
 * Accepts a MongoClient, or a `pg` Pool or Client from a bundled `pg` (its
 * class is wrapped once). Safe to call on every request with the same cached
 * client (attaches once, warns at most once), and before or after init().
 * Never throws.
 */
export function instrument(client: MongoClientLike): void {
  try {
    const report = (e: Error): void => {
      try {
        const s = currentSink();
        if (s) s.onError(e);
        else defaultOnError(e);
      } catch { /* never throw from reporting */ }
    };
    if (typeof client !== 'object' || client === null) return;
    // A pg Pool or Client (a bundled pg the SDK can't resolve) is wrapped, never watched as a MongoClient.
    if (wrapPg(client, true)) return;
    watchClient(client, report);
  } catch { /* never throw into app code */ }
}

export type { MongoClientLike };

export async function shutdown(): Promise<void> {
  // Important 3: the instance's own `shutdown()` now clears module-level
  // `active`/`activeOptions` itself (via clearActiveIfSelf), so this and
  // `analyser.shutdown()` are the same operation either way it's called.
  await active?.shutdown();
}

// Public API surface fix (pre-publish): `Aggregator`, `buildSignature`,
// `redact` and `MongooseLike` used to be re-exported here. Once published to
// npm those become semver-locked forever. None of them are part of the
// SDK's actual contract with a consumer — the public surface is `init`,
// `shutdown`, `instrument`, `SDK_VERSION`, and the `InitOptions`/`Analyser`/
// `MongoClientLike` types (plus this default export). Tests that need the internals import them directly
// from their own modules (./aggregator.js, ./signature.js, ./redact.js).
export default { init, shutdown, instrument };
