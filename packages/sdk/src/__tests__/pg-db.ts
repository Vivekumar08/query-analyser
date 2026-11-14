/**
 * Throwaway PostgreSQL databases for tests (SDK integration tests, and the compat suites through a
 * relative import). Every database is named `qa_sdk_<prefix>_<pid>_<6 hex>`, created over the base URL,
 * and dropped with `DROP DATABASE IF EXISTS … WITH (FORCE)`. Nothing here ever touches a database it did
 * not create, and no connection URL (which carries credentials) is ever logged or put in an error.
 */
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const API_ENV = fileURLToPath(new URL('../../../../apps/api/.env', import.meta.url));
const NAME = /^qa_sdk_[a-z0-9_]+$/;

/** DATABASE_URL from apps/api/.env (a regex over the file; quotes stripped), or null. */
function urlFromApiEnv(): string | null {
  let text: string;
  try { text = readFileSync(API_ENV, 'utf8'); } catch { return null; }
  const m = /^[ \t]*(?:export[ \t]+)?DATABASE_URL[ \t]*=[ \t]*(.*?)[ \t]*$/m.exec(text);
  if (!m) return null;
  const v = m[1]!.replace(/^(['"])(.*)\1$/, '$2').trim();
  return v === '' ? null : v;
}

/** The base URL: QA_PG_URL, else DATABASE_URL read from apps/api/.env. Throws a clear error when neither exists. Never logged. */
export function basePgUrl(): string {
  const fromEnv = process.env.QA_PG_URL;
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv.trim();
  const fromFile = urlFromApiEnv();
  if (fromFile !== null) return fromFile;
  throw new Error('pg-db: no Postgres URL; set QA_PG_URL or DATABASE_URL in apps/api/.env');
}

/** The base URL pointed at another database (query string, e.g. sslmode, kept). */
function urlFor(base: string, database: string): string {
  const u = new URL(base);
  u.pathname = `/${encodeURIComponent(database)}`;
  return u.toString();
}

/** A short, credential-free reason for a failure (an error code or class name, never a message). */
function reasonOf(e: unknown): string {
  const code = (e as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && code !== '') return code;
  return e instanceof Error ? e.name : 'unknown error';
}

async function withAdmin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: basePgUrl(), connectionTimeoutMillis: 5000 });
  // A connection error must not escape as an 'error' event with the client's details.
  c.on('error', () => {});
  try {
    await c.connect();
  } catch (e) {
    throw new Error(`pg-db: could not connect to Postgres (${reasonOf(e)})`);
  }
  try { return await fn(c); } finally { await c.end().catch(() => {}); }
}

/** Whether a Postgres is reachable over the base URL; `reason` is safe to print. */
export async function pgAvailable(): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    await withAdmin((c) => c.query('SELECT 1'));
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: e instanceof Error && e.message.startsWith('pg-db:') ? e.message.slice('pg-db: '.length) : reasonOf(e) };
  }
}

/** CREATE DATABASE "qa_sdk_<prefix>_<pid>_<6 random hex>" over the base URL; drop() runs DROP DATABASE IF EXISTS … WITH (FORCE). */
export async function createThrowawayDb(prefix: string): Promise<{ url: string; name: string; drop(): Promise<void> }> {
  const name = `qa_sdk_${prefix}_${process.pid}_${randomBytes(3).toString('hex')}`;
  if (!NAME.test(name) || name.length > 63) throw new Error(`pg-db: invalid database prefix ${JSON.stringify(prefix)} (use [a-z0-9_])`);
  const base = basePgUrl();
  await withAdmin((c) => c.query(`CREATE DATABASE "${name}"`));
  let dropped: Promise<void> | null = null;
  return {
    url: urlFor(base, name),
    name,
    drop() {
      // A failed drop is not memoised, so a later call tries again.
      dropped ??= withAdmin(async (c) => { await c.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`); })
        .catch((e: unknown) => { dropped = null; throw e; });
      return dropped;
    },
  };
}

/**
 * Orphan sweep (sdk-compat globalSetup). A run killed before its afterAll leaves `qa_sdk_…` databases behind.
 * One is swept only when its name matches exactly, the pid in it is not this process and is gone (ESRCH; EPERM
 * means alive), and the base URL is a local host. Plain `DROP DATABASE IF EXISTS`, never FORCE: a database
 * still in use stays. `qa` never matches.
 */
export const ORPHAN_NAME = /^qa_sdk_[a-z0-9_]+_(\d+)_[0-9a-f]{6}$/;

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/** Whether a Postgres URL points at this machine (localhost, 127.0.0.1, ::1 or a Unix socket). */
export function isLocalPgUrl(url: string): boolean {
  try {
    const u = new URL(url);
    const host = decodeURIComponent(u.searchParams.get('host') ?? u.hostname).toLowerCase();
    return host === '' || host.startsWith('/') || LOCAL_HOSTS.has(host);
  } catch {
    return false;
  }
}

type Kill = (pid: number, signal: 0) => unknown;

/** Signal 0: ESRCH means the process is gone; success, EPERM or anything else counts as alive. */
export function pidAlive(pid: number, kill: Kill = process.kill.bind(process) as Kill): boolean {
  try {
    kill(pid, 0);
    return true;
  } catch (e) {
    return (e as { code?: unknown } | null)?.code !== 'ESRCH';
  }
}

export interface SweepContext { selfPid: number; baseUrl: string; kill?: Kill }

/** The sweep decision for one database name. */
export function shouldSweep(name: string, ctx: SweepContext): boolean {
  if (name === 'qa') return false;
  const m = ORPHAN_NAME.exec(name);
  if (!m) return false;
  const pid = Number(m[1]);
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid === ctx.selfPid) return false;
  if (!isLocalPgUrl(ctx.baseUrl)) return false;
  return !pidAlive(pid, ctx.kill);
}

export interface SweepIo extends SweepContext {
  list(): Promise<string[]>;
  exec(sql: string): Promise<unknown>;
}

/** Drops every orphan `list()` returns; returns the names dropped. Never throws. */
export async function sweepOrphans(io: SweepIo): Promise<string[]> {
  const dropped: string[] = [];
  try {
    if (!isLocalPgUrl(io.baseUrl)) return dropped;
    for (const name of await io.list()) {
      if (!shouldSweep(name, io)) continue;
      try {
        await io.exec(`DROP DATABASE IF EXISTS "${name}"`);
        dropped.push(name);
      } catch { /* still in use, or no permission: leave it */ }
    }
  } catch { /* Postgres down: nothing to sweep */ }
  return dropped;
}

/** The real sweep over the base URL. Prints names only, never a URL. */
export async function sweepOrphanDbs(): Promise<string[]> {
  let baseUrl: string;
  try { baseUrl = basePgUrl(); } catch { return []; }
  if (!isLocalPgUrl(baseUrl)) return [];
  try {
    return await withAdmin((c) => sweepOrphans({
      baseUrl, selfPid: process.pid,
      list: async () => (await c.query<{ datname: string }>("SELECT datname FROM pg_database WHERE datname LIKE 'qa\\_sdk\\_%'")).rows.map((r) => r.datname),
      exec: (sql) => c.query(sql),
    }));
  } catch {
    return [];
  }
}
