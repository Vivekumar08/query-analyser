import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { gunzipSync } from 'node:zlib';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import pg from 'pg';
import { init, shutdown } from '../index.js';
import { maskName } from '../sql/fingerprint.js';
// Test-only: the contract is a dev dependency, used to prove every real body parses under the ingest schema.
import { ingestPayloadSchema } from '@query-analyser/contract';
import { createThrowawayDb, pgAvailable } from './pg-db.js';

// Probed once at collection time: without a reachable Postgres the suite is skipped, never failed.
const available = await pgAvailable();
if (!available.ok) {
  // eslint-disable-next-line no-console
  console.warn(`[pg-integration] skipped: no reachable Postgres (${available.reason}). Set QA_PG_URL or apps/api/.env DATABASE_URL.`);
}

type Db = Awaited<ReturnType<typeof createThrowawayDb>>;
type SentItem = {
  hash: string; signature: string; model: string; collection: string; operation: string;
  count: number; hist: number[]; histFine?: number[]; errors?: number;
  errorCodes?: { code: string; count: number }[]; sampleRate?: number; database?: string; sql?: string; source: string;
};

/** A fetch double that keeps every body (gunzipped when the transport compressed it). */
function capture() {
  const bodies: string[] = [];
  const fetchImpl = vi.fn(async (_url: string | URL | Request, req?: RequestInit) => {
    const gz = (req?.headers as Record<string, string> | undefined)?.['Content-Encoding'] === 'gzip';
    const body = req?.body;
    if (gz && body) {
      const buf = Buffer.isBuffer(body) ? body : Buffer.from(body as unknown as Uint8Array);
      bodies.push(gunzipSync(buf).toString('utf8'));
    } else {
      bodies.push(typeof body === 'string' ? body : String(body));
    }
    return new Response('{}', { status: 202 });
  }) as unknown as typeof fetch;
  return { bodies, fetchImpl };
}

/** Every sent item; each body must parse under the contract's ingest schema. */
function itemsOf(bodies: string[]): SentItem[] {
  return bodies.flatMap((b) => {
    const parsed = JSON.parse(b);
    ingestPayloadSchema.parse(parsed);
    return parsed.items as SentItem[];
  });
}

const sqlOf = (i: SentItem): string => i.sql ?? i.signature;
const sum = (xs: readonly number[] | undefined): number => (xs ?? []).reduce((a, b) => a + b, 0);
/** The one item whose SQL matches. */
function itemMatching(items: SentItem[], re: RegExp): SentItem {
  const found = items.filter((i) => re.test(sqlOf(i)));
  expect(found, `items matching ${re}: ${items.map(sqlOf).join(' | ')}`).toHaveLength(1);
  return found[0]!;
}

describe.skipIf(!available.ok)('pg against a real Postgres (throwaway database)', () => {
  let db: Db;
  let pool: pg.Pool;
  /** A small pool, so concurrent queries queue for a client. */
  let tight: pg.Pool;

  beforeAll(async () => {
    db = await createThrowawayDb('it');
    // Both pools exist before any init(): clients created before init() must be covered.
    pool = new pg.Pool({ connectionString: db.url, max: 10 });
    tight = new pg.Pool({ connectionString: db.url, max: 2 });
    await pool.query('CREATE TABLE t (id serial PRIMARY KEY, email text UNIQUE, n int)');
    await pool.query(`INSERT INTO t (email, n) VALUES ('seed@x.test', 1), ('canary-dup@x.test', 2), ('third@x.test', 3)`);
    await pool.query('CREATE TABLE qa_secret_orders (id int PRIMARY KEY, secret_col text)');
  }, 60_000);

  afterAll(async () => {
    await shutdown();
    await tight?.end().catch(() => {});
    await pool?.end().catch(() => {});
    await db?.drop();
  }, 60_000);

  afterEach(async () => { await shutdown(); });

  const start = (extra: Record<string, unknown> = {}) => {
    const { bodies, fetchImpl } = capture();
    const errors: Error[] = [];
    const a = init({ apiKey: 'k', app: 'it', thresholdMs: 0, fetchImpl, onError: (e) => { errors.push(e); }, ...extra });
    return { a, bodies, errors };
  };

  it('counts each form exactly once: Pool.query, PoolClient.query, Client.query, callback, promise, config, named twice', async () => {
    const { a, bodies } = start();
    const client = new pg.Client({ connectionString: db.url });
    await client.connect();
    try {
      await pool.query('SELECT id FROM t WHERE id = $1', [1]); // Pool.query
      const pc = await pool.connect();
      try { await pc.query('SELECT email FROM t WHERE id = $1', [1]); } finally { pc.release(); } // PoolClient.query
      await client.query('SELECT n FROM t WHERE id = $1', [1]); // Client.query (text, values)
      await new Promise<void>((resolve, reject) => { // callback
        client.query('SELECT id, n FROM t WHERE id = $1', [2], (err) => (err ? reject(err) : resolve()));
      });
      await client.query('SELECT id, email FROM t'); // promise, text only
      await client.query({ text: 'SELECT email, n FROM t WHERE id = $1', values: [3] }); // config
      for (const v of [1, 2]) await client.query({ name: 'named-q', text: 'SELECT id, email, n FROM t WHERE id = $1', values: [v] }); // named, twice
    } finally {
      await client.end();
    }
    await a.flush();

    const items = itemsOf(bodies);
    expect(sum(items.map((i) => i.count))).toBe(8);
    expect(items).toHaveLength(7);
    expect(itemMatching(items, /SELECT id, email, n FROM/i).count).toBe(2);
    for (const i of items) expect(i).toMatchObject({ source: 'postgresql', database: db.name, errors: 0 });
  });

  it('results, errors and callback arity are identical with and without the SDK', async () => {
    const client = new pg.Client({ connectionString: db.url });
    await client.connect();
    const run = async () => {
      const out: unknown[] = [];
      const r1 = await pool.query('SELECT id, email, n FROM t ORDER BY id');
      out.push({ rows: r1.rows, rowCount: r1.rowCount, command: r1.command });
      out.push(await new Promise((resolve) => {
        client.query('SELECT n FROM t WHERE id = $1', [2], function (this: unknown, ...args: unknown[]) {
          const [err, res] = args as [Error | null, pg.QueryResult];
          resolve({ arity: args.length, err, rows: res?.rows });
        });
      }));
      const dup = await pool.query('INSERT INTO t (email) VALUES ($1)', ['seed@x.test']).then(() => null, (e: pg.DatabaseError) => e);
      out.push({ code: dup?.code, message: dup?.message, constraint: dup?.constraint, ctor: dup?.constructor });
      out.push(await new Promise((resolve) => {
        client.query('SELECT broken FROM t', (...args: unknown[]) => {
          const [err] = args as [pg.DatabaseError];
          resolve({ arity: args.length, code: err.code, message: err.message });
        });
      }));
      const r5 = await client.query({ text: 'SELECT id, n FROM t WHERE id <= $1 ORDER BY id', values: [2], rowMode: 'array' });
      out.push({ rows: r5.rows, fields: r5.fields.map((f) => f.name) });
      return out;
    };
    try {
      await shutdown();
      const without = await run();
      const { a, bodies } = start();
      const withSdk = await run();
      await a.flush();
      expect(withSdk).toEqual(without);
      expect(sum(itemsOf(bodies).map((i) => i.count))).toBe(5);
    } finally {
      await client.end();
    }
  });

  it('a failed statement is counted with its SQLSTATE and never its detail', async () => {
    const { a, bodies } = start();
    await expect(pool.query(`INSERT INTO t (email) VALUES ('canary-dup@x.test')`)).rejects.toMatchObject({ code: '23505' });
    await a.flush();

    const item = itemMatching(itemsOf(bodies), /^INSERT/i);
    expect(item).toMatchObject({ count: 1, errors: 1, errorCodes: [{ code: '23505', count: 1 }] });
    expect(bodies.join('\n')).not.toContain('canary-dup');
    expect(bodies.join('\n')).not.toMatch(/already exists|duplicate key/i);
  });

  it('never sends a value: literals, $n params, comments, dollar quotes, E strings', async () => {
    const { a, bodies } = start();
    await pool.query(`SELECT 'canary-lit-1' AS a`);
    await pool.query('SELECT $1::text AS a, $2::int AS b', ['canary-param-2', 987654321]);
    await pool.query('SELECT /* canary-comment-3 */ 1 AS a -- canary-line-4\n');
    await pool.query('SELECT $$canary-dollar-5$$ AS a, $tag$canary-tag-6$tag$ AS b');
    await pool.query(`SELECT E'canary-estr-7\\n' AS a`);
    await pool.query('SELECT id FROM t WHERE n = 123456789 OR email = $1', ['canary-param-8@x.test']);
    await pool.query('UPDATE t SET n = $1 WHERE email = $2', [42, 'canary-param-9@x.test']);
    await a.flush();

    const items = itemsOf(bodies); // parses each body under ingestPayloadSchema
    expect(sum(items.map((i) => i.count))).toBe(7);
    const all = bodies.join('\n');
    expect(all).not.toMatch(/canary/i);
    expect(all).not.toContain('987654321');
    expect(all).not.toContain('123456789');
    for (const i of items) expect(i).toMatchObject({ sample: null });
    for (const i of items) expect(i).not.toHaveProperty('encryptedSample');
  });

  it('two pools to two databases are both captured, each statement once', async () => {
    const other = await createThrowawayDb('it');
    const pool2 = new pg.Pool({ connectionString: other.url, max: 2 });
    try {
      const { a, bodies } = start();
      await pool.query('SELECT 1 AS one, 2 AS two');
      await pool2.query('SELECT 1 AS one, 2 AS two');
      await a.flush();
      const items = itemsOf(bodies);
      expect(items).toHaveLength(1);
      // Decision 10: one row for the same SQL; the first database used wins.
      expect(items[0]).toMatchObject({ count: 2, database: db.name });
    } finally {
      await pool2.end().catch(() => {});
      await other.drop();
    }
  });

  it('a pg-cursor-like submittable is untouched and uncounted', async () => {
    const { a, bodies, errors } = start();
    const client = await pool.connect();
    try {
      const q = new pg.Query('SELECT 1 AS sub');
      const rows: unknown[] = [];
      q.on('row', (r: unknown) => rows.push(r));
      const ended = once(q, 'end');
      expect(client.query(q as never)).toBe(q);
      await ended;
      expect(rows).toEqual([{ sub: 1 }]);
    } finally {
      client.release();
    }
    await a.flush();
    expect(itemsOf(bodies)).toEqual([]);
    expect(errors).toEqual([]);
  });

  it('a contended pool counts every queued statement exactly once', async () => {
    const { a, bodies } = start();
    const results = await Promise.all(
      Array.from({ length: 30 }, (_, i) => tight.query('SELECT pg_sleep(0.005), $1::int AS i', [i])),
    );
    expect(results.map((r) => r.rows[0].i)).toEqual(Array.from({ length: 30 }, (_, i) => i));
    await a.flush();
    const item = itemMatching(itemsOf(bodies), /pg_sleep/i);
    expect(item.count).toBe(30);
    expect(sum(item.hist)).toBe(30);
    expect(sum(item.histFine)).toBe(30);
  });

  it('maskIdentifiers hides table, column and database names while keywords stay readable', async () => {
    const { a, bodies } = start({ sql: { maskIdentifiers: true } });
    await pool.query('SELECT secret_col FROM qa_secret_orders WHERE id = $1', [1]);
    await a.flush();
    const [item, ...rest] = itemsOf(bodies);
    expect(rest).toEqual([]);
    const all = bodies.join('\n');
    expect(all).not.toMatch(/secret_col|qa_secret_orders/);
    expect(all).not.toContain(db.name);
    // Keyed by sha256('qa-mask:' + apiKey), so the masked names are stable for this app's key.
    const key = createHash('sha256').update('qa-mask:k').digest();
    expect(item!.model).toBe(maskName('qa_secret_orders', key));
    expect(item!.collection).toBe(maskName('qa_secret_orders', key));
    expect(item!.database).toBe(maskName(db.name, key));
    expect(sqlOf(item!)).toContain(maskName('secret_col', key));
    expect(sqlOf(item!)).toMatch(/^SELECT .* FROM .* WHERE/);
  });

  it('sampling at 0.1: scaled counts within 20% of the truth, slow statements and errors exact', async () => {
    // The default threshold (100 ms): pg_sleep(0.15) is slow, SELECT $1::int is fast.
    const { a, bodies } = start({ thresholdMs: undefined, sql: { sampleRate: 0.1 } });
    const FAST = 2000;
    for (let i = 0; i < FAST; i += 20) {
      await Promise.all(Array.from({ length: 20 }, (_, j) => pool.query('SELECT $1::int AS fast', [i + j])));
    }
    await Promise.all(Array.from({ length: 5 }, () => pool.query('SELECT pg_sleep(0.15)')));
    for (let i = 0; i < 3; i++) {
      await expect(pool.query('SELECT 1 / $1::int AS boom', [0])).rejects.toMatchObject({ code: '22012' });
    }
    await a.flush();

    const items = itemsOf(bodies);
    const fast = itemMatching(items, /AS fast/i);
    expect(fast.count).toBeGreaterThanOrEqual(1600);
    expect(fast.count).toBeLessThanOrEqual(2400);
    const sleep = itemMatching(items, /pg_sleep/i);
    expect(sleep.count).toBe(5);
    expect(sum(sleep.hist)).toBe(5);
    const boom = itemMatching(items, /boom/i);
    expect(boom).toMatchObject({ count: 3, errors: 3, errorCodes: [{ code: '22012', count: 3 }] });
    for (const i of items) expect(i.sampleRate).toBe(0.1);
  }, 120_000);

  it('statements under the threshold are counted when thresholdMs is the default 100', async () => {
    const { a, bodies } = start({ thresholdMs: undefined });
    await pool.query('SELECT 1');
    await a.flush();
    const items = itemsOf(bodies);
    expect(items).toHaveLength(1);
    expect(items[0]!.count).toBe(1);
    expect(items[0]!.hist.every((b) => b === 0)).toBe(true);
    expect(sum(items[0]!.histFine)).toBe(1);
  });
});
