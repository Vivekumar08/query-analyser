import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { init, shutdown } from '../../sdk/src/index.js';
import { installPgPoolWrap, installPgWrap } from '../../sdk/src/integrations/pg.js';
import { createThrowawayDb, pgAvailable } from '../../sdk/src/__tests__/pg-db.js';
import { PGS, capture, itemsOf, sqlOf, sum, type PgItem } from './pg-harness.js';

/**
 * Every `pg` 8 minor against a real Postgres, each suite in its own throwaway
 * database (dropped in afterAll). Each test calls init() and then
 * installPgWrap(mod.Client) (and installPgPoolWrap(mod.Pool), as init() does
 * for a resolved copy): the aliased copy is not the `pg` init() resolves, so
 * its prototypes are wrapped here exactly as init() wraps the resolved one.
 */

// Probed once at collection time: without a reachable Postgres the matrix is skipped, never failed.
const available = await pgAvailable();
if (!available.ok) {
  // eslint-disable-next-line no-console
  console.warn(`[pg compat] skipped: no reachable Postgres (${available.reason}). Set QA_PG_URL or apps/api/.env DATABASE_URL.`);
}

const require = createRequire(import.meta.url);

type Db = Awaited<ReturnType<typeof createThrowawayDb>>;

/** The one item whose SQL matches. */
function itemMatching(items: PgItem[], re: RegExp): PgItem {
  const found = items.filter((i) => re.test(sqlOf(i)));
  expect(found, `items matching ${re}: ${items.map(sqlOf).join(' | ')}`).toHaveLength(1);
  return found[0]!;
}

/** Resolves once `cond()` holds, or after `ms`. */
async function until(cond: () => boolean, ms = 2000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
}

describe.skipIf(!available.ok).each(PGS)('pg $minor', ({ minor, alias, version, mod }) => {
  let db: Db;
  let pool: InstanceType<typeof mod.Pool>;
  const clients: InstanceType<typeof mod.Client>[] = [];

  beforeAll(async () => {
    db = await createThrowawayDb(`compat_${alias}`);
    pool = new mod.Pool({ connectionString: db.url, max: 4 });
    await pool.query('CREATE TABLE t (id serial PRIMARY KEY, email text UNIQUE, n int)');
    await pool.query(`INSERT INTO t (email, n) VALUES ('seed@x.test', 1), ('canary-dup@x.test', 2), ('third@x.test', 3)`);
  }, 60_000);

  afterAll(async () => {
    await shutdown();
    await Promise.all(clients.splice(0).map((c) => c.end().catch(() => {})));
    await pool?.end().catch(() => {});
    await db?.drop();
  }, 60_000);

  afterEach(async () => {
    await shutdown();
    await Promise.all(clients.splice(0).map((c) => c.end().catch(() => {})));
  });

  function start() {
    const { bodies, fetchImpl } = capture();
    const errors: Error[] = [];
    const a = init({ apiKey: 'k', app: `compat-pg${minor}`, thresholdMs: 0, fetchImpl, onError: (e) => { errors.push(e); } });
    installPgWrap(mod.Client);
    installPgPoolWrap(mod.Pool);
    return { a, bodies, errors };
  }
  async function client() {
    const c = new mod.Client({ connectionString: db.url });
    clients.push(c);
    await c.connect();
    return c;
  }

  it(`loads pg ${version}`, () => {
    expect((require(`${alias}/package.json`) as { version: string }).version).toBe(version);
    expect((require(alias) as typeof mod).Client).toBe(mod.Client);
  });

  it('every form passes through the wrapper exactly once', async () => {
    const { a, bodies } = start();
    const c = await client();
    await pool.query('SELECT id FROM t WHERE id = $1', [1]); // Pool.query
    const pc = await pool.connect();
    try { await pc.query('SELECT email FROM t WHERE id = $1', [1]); } finally { pc.release(); } // PoolClient.query
    await c.query('SELECT n FROM t WHERE id = $1', [1]); // Client.query (text, values)
    await new Promise<void>((resolve, reject) => { // callback
      c.query('SELECT id, n FROM t WHERE id = $1', [2], (err) => (err ? reject(err) : resolve()));
    });
    await c.query('SELECT id, email FROM t'); // promise, text only
    await c.query({ text: 'SELECT email, n FROM t WHERE id = $1', values: [3] }); // config
    await c.query({ text: 'SELECT n, id FROM t WHERE id = $1', values: [3], rowMode: 'array' }); // rowMode array
    for (const v of [1, 2]) await c.query({ name: 'named-q', text: 'SELECT id, email, n FROM t WHERE id = $1', values: [v] }); // named, twice
    await a.flush();

    const items = itemsOf(bodies);
    expect(sum(items.map((i) => i.count))).toBe(9);
    expect(items).toHaveLength(8);
    expect(itemMatching(items, /SELECT id, email, n FROM/i).count).toBe(2);
    for (const i of items) expect(i).toMatchObject({ source: 'postgresql', database: db.name, errors: 0 });
  });

  it('an ignored failing promise raises one unhandledRejection with the same error', async () => {
    // pg builds its promise with client.Promise (8.0 onwards); this subclass notes every rejection
    // reason, so the event's reason can be checked against the very error pg rejected with.
    const rejected: unknown[] = [];
    class Noting<T> extends Promise<T> {
      constructor(exec: (res: (v: T) => void, rej: (e: unknown) => void) => void) {
        super((res, rej) => exec(res, (e) => { rejected.push(e); rej(e); }));
      }
    }
    // Take vitest's own listeners off for the duration, so the event reaches only ours.
    const saved = process.listeners('unhandledRejection');
    process.removeAllListeners('unhandledRejection');
    const seen: unknown[] = [];
    const on = (e: unknown): void => { seen.push(e); };
    process.on('unhandledRejection', on);
    const fireAndForget = async () => {
      rejected.length = 0; seen.length = 0;
      const c = new mod.Client({ connectionString: db.url, Promise: Noting } as never);
      clients.push(c);
      await c.connect();
      void c.query('SELECT * FROM qa_missing_table'); // never awaited
      await until(() => seen.length > 0);
      await new Promise((r) => setTimeout(r, 50)); // a second event would arrive by now
      expect(seen).toHaveLength(1);
      expect(seen[0]).toMatchObject({ code: '42P01' });
      expect(rejected.length).toBeGreaterThan(0);
      for (const r of rejected) expect(r).toBe(seen[0]);
      return { code: (seen[0] as { code: string }).code, message: (seen[0] as Error).message, ctor: (seen[0] as Error).constructor };
    };
    try {
      const without = await fireAndForget(); // control: no SDK
      const { a, bodies } = start();
      const withSdk = await fireAndForget();
      expect(withSdk).toEqual(without);
      await a.flush();
      const item = itemMatching(itemsOf(bodies), /qa_missing_table/i);
      expect(item).toMatchObject({ count: 1, errors: 1, errorCodes: [{ code: '42P01', count: 1 }] });
    } finally {
      process.off('unhandledRejection', on);
      for (const l of saved) process.on('unhandledRejection', l as (...args: unknown[]) => void);
    }
  });

  it('results and errors are identical with and without the SDK', async () => {
    const c = await client();
    type Err = { code?: string; message?: string; constraint?: string; constructor?: unknown };
    const run = async () => {
      const out: unknown[] = [];
      const p1 = pool.query('SELECT id, email, n FROM t ORDER BY id');
      out.push({ ctor: p1.constructor });
      const r1 = await p1;
      out.push({ rows: r1.rows, rowCount: r1.rowCount, command: r1.command, fields: r1.fields.map((f) => f.name) });
      out.push(await new Promise((resolve) => {
        c.query('SELECT n FROM t WHERE id = $1', [2], function (this: unknown, ...args: unknown[]) {
          const [err, res] = args as [Error | null, { rows: unknown[] }];
          resolve({ arity: args.length, err, rows: res?.rows });
        });
      }));
      out.push(await new Promise((resolve) => {
        c.query({
          text: 'SELECT email FROM t WHERE id = $1', values: [3],
          callback: (...args: unknown[]) => {
            const [err, res] = args as [Error | null, { rows: unknown[] }];
            resolve({ arity: args.length, err, rows: res?.rows });
          },
        } as never);
      }));
      const dup = await pool.query('INSERT INTO t (email) VALUES ($1)', ['seed@x.test']).then(() => null, (e: Err) => e);
      out.push({ code: dup?.code, message: dup?.message, constraint: dup?.constraint, ctor: dup?.constructor });
      out.push(await new Promise((resolve) => {
        c.query('SELECT broken FROM t', (...args: unknown[]) => {
          const [err] = args as [Err];
          resolve({ arity: args.length, code: err.code, message: err.message, ctor: err.constructor });
        });
      }));
      const r7 = await c.query({ text: 'SELECT id, n FROM t WHERE id <= $1 ORDER BY id', values: [2], rowMode: 'array' });
      out.push({ rows: r7.rows, fields: r7.fields.map((f) => f.name) });
      return out;
    };
    await shutdown();
    const without = await run();
    const { a, bodies } = start();
    const withSdk = await run();
    await a.flush();
    expect(withSdk).toEqual(without);
    expect(sum(itemsOf(bodies).map((i) => i.count))).toBe(6);
  });

  it('a submittable (new mod.Query) is untouched and uncounted', async () => {
    const { a, bodies, errors } = start();
    const pc = await pool.connect();
    try {
      const q = new mod.Query('SELECT 1 AS sub');
      const rows: unknown[] = [];
      q.on('row', (r: unknown) => rows.push(r));
      const ended = once(q, 'end');
      expect(pc.query(q as never)).toBe(q);
      await ended;
      expect(rows).toEqual([{ sub: 1 }]);
    } finally {
      pc.release();
    }
    await a.flush();
    expect(itemsOf(bodies)).toEqual([]);
    expect(errors).toEqual([]);
  });

  it('client.database is the throwaway db name', async () => {
    const { a, bodies } = start();
    const c = await client();
    await c.query('SELECT 1 AS via_client');
    await pool.query('SELECT 1 AS via_pool');
    await a.flush();
    const items = itemsOf(bodies);
    expect(items).toHaveLength(2);
    for (const item of items) expect(item.database).toBe(db.name);
  });

  it('never sends a value', async () => {
    const { a, bodies } = start();
    await pool.query(`SELECT 'canary-lit-1' AS a`);
    await pool.query('SELECT $1::text AS a, $2::int AS b', ['canary-param-2', 987654321]);
    await pool.query('SELECT /* canary-comment-3 */ 1 AS a -- canary-line-4\n');
    await pool.query('SELECT $$canary-dollar-5$$ AS a, $tag$canary-tag-6$tag$ AS b');
    await pool.query(`SELECT E'canary-estr-7\\n' AS a`);
    await pool.query('SELECT id FROM t WHERE n = 123456789 OR email = $1', ['canary-param-8@x.test']);
    await pool.query('UPDATE t SET n = $1 WHERE email = $2', [42, 'canary-param-9@x.test']);
    await expect(pool.query(`INSERT INTO t (email) VALUES ('canary-dup@x.test')`)).rejects.toMatchObject({ code: '23505' });
    await a.flush();

    const items = itemsOf(bodies); // parses each body under ingestPayloadSchema
    expect(sum(items.map((i) => i.count))).toBe(8);
    const all = bodies.join('\n');
    expect(all).not.toMatch(/canary/i);
    expect(all).not.toContain('987654321');
    expect(all).not.toContain('123456789');
    expect(all).not.toMatch(/already exists|duplicate key/i);
    for (const i of items) expect(i).toMatchObject({ sample: null });
    for (const i of items) expect(i).not.toHaveProperty('encryptedSample');
  });
});
