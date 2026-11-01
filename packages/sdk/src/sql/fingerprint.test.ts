import { describe, it, expect, vi } from 'vitest';
import { createHash } from 'node:crypto';

vi.mock('./lexer.js', async (importOriginal) => {
  const m = await importOriginal<typeof import('./lexer.js')>();
  return { ...m, lex: vi.fn(m.lex) };
});

import { lex } from './lexer.js';
import { fingerprintSql, maskName, createFingerprinter, MAX_SQL_CHARS, MAX_INPUT_CHARS } from './fingerprint.js';

const plain = { maskIdentifiers: false };
const sha = (s: string): string => createHash('sha256').update(s).digest('hex');

describe('fingerprintSql', () => {
  it.each([
    [`SELECT * FROM users WHERE email = 'a@b.c'`, 'SELECT * FROM users WHERE email = ?', 'select', 'users'],
    [`select id from "public"."User" where "User"."email" = $1 limit $2 offset $3`, `SELECT id FROM "public"."User" WHERE "User"."email" = ? LIMIT ? OFFSET ?`, 'select', 'User'],
    ['SELECT a FROM t WHERE id IN (1, 2, 3) AND b NOT IN ($1,$2)', 'SELECT a FROM t WHERE id IN (?) AND b NOT IN (?)', 'select', 't'],
    ['SELECT a FROM t WHERE id = ANY (ARRAY[$1, $2, $3])', 'SELECT a FROM t WHERE id = ANY (ARRAY[?])', 'select', 't'],
    [`INSERT INTO "public"."Product" ("sku","name") VALUES ($1,$2), ($3,$4) RETURNING "public"."Product"."id"`, `INSERT INTO "public"."Product" ("sku", "name") VALUES (?, ?) RETURNING "public"."Product"."id"`, 'insert', 'Product'],
    [`/* traceparent='00-ab-cd-01' */ SELECT a FROM t -- trailing`, 'SELECT a FROM t', 'select', 't'],
    [`SELECT $tag$secret$tag$, E'x\\'y', 1.5e3, 0x1F, NULL, TRUE`, 'SELECT ?, ?, ?, ?, NULL, ?', 'select', null],
    [`SELECT $1::text, '2020-01-01'::date`, 'SELECT ?::text, ?::date', 'select', null],
    [`select COUNT(*) AS "_count$_all" from Users`, `SELECT count(*) AS "_count$_all" FROM users`, 'select', 'users'],
    ['WITH x AS (SELECT a FROM t) UPDATE u SET a = 1 FROM x', 'WITH x AS (SELECT a FROM t) UPDATE u SET a = ? FROM x', 'update', 'u'],
    ['(SELECT 1)', '(SELECT ?)', 'select', null],
    ['TABLE users', 'TABLE users', 'table', 'users'],
    [`SELECT "title"::text LIKE ($1 || $2 || $3) FROM "Post"`, `SELECT "title"::text LIKE (? || ? || ?) FROM "Post"`, 'select', 'Post'],
    [`SELECT 'abc`, 'SELECT ?', 'select', null],
  ])('normalises %s', (input, sql, verb, table) => {
    const f = fingerprintSql(input, plain);
    expect(f).toEqual({ sql, hash: sha(`postgresql\n${sql}`).slice(0, 16), verb, table });
  });

  it.each(['BEGIN', 'COMMIT', 'ROLLBACK', 'SAVEPOINT a', 'RELEASE a', 'SET search_path TO x', 'SHOW x', 'RESET x', 'DISCARD ALL',
    'DEALLOCATE x', 'LISTEN c', 'CREATE TABLE t (a int)', 'ALTER TABLE t ADD b int', 'DROP TABLE t', 'WITH x AS (SELECT 1) ', ''])
    ('ignores %j', (s) => expect(fingerprintSql(s, plain)).toBeNull());

  it('finds the main verb after WITH RECURSIVE and several CTEs', () => {
    const f = fingerprintSql('WITH RECURSIVE a(n) AS (SELECT 1 UNION SELECT n FROM a), b AS (DELETE FROM z RETURNING *) INSERT INTO "s"."T" SELECT n FROM a', plain)!;
    expect(f.verb).toBe('insert');
    expect(f.table).toBe('T');
  });

  it('takes the table at depth 0 only and skips ONLY', () => {
    expect(fingerprintSql('SELECT extract(year FROM d) FROM ONLY Events e', plain)!.table).toBe('events');
    expect(fingerprintSql('SELECT * FROM (SELECT 1 FROM inner_t) s', plain)!.table).toBeNull();
    expect(fingerprintSql('DELETE FROM "Order" WHERE id = 1', plain)).toMatchObject({ verb: 'delete', table: 'Order' });
    expect(fingerprintSql('UPDATE a.b SET c = 1', plain)).toMatchObject({ verb: 'update', table: 'b' });
    expect(fingerprintSql('SELECT 1 FOR UPDATE OF t', plain)!.table).toBeNull();
    expect(fingerprintSql('VALUES (1), (2)', plain)).toMatchObject({ sql: 'VALUES (?)', verb: 'values', table: null });
  });

  it('collapses VALUES tuples with nested parentheses and keeps what follows', () =>
    expect(fingerprintSql('INSERT INTO t (a, b) VALUES (lower($1), (2)), (lower($3), (4)) ON CONFLICT DO NOTHING', plain)!.sql)
      .toBe('INSERT INTO t(a, b) VALUES (lower(?), (?)) ON CONFLICT DO NOTHING'));

  it.each([
    ['SELECT a FROM t WHERE x = -5', 'SELECT a FROM t WHERE x = ?'],
    ['SELECT a FROM t WHERE x = - -5', 'SELECT a FROM t WHERE x = ?'],
    ['SELECT -1, +2.5', 'SELECT ?, ?'],
    ['SELECT a FROM t WHERE id IN (-1, -2, +3)', 'SELECT a FROM t WHERE id IN (?)'],
    ['SELECT ARRAY[-1,-2]', 'SELECT ARRAY[?]'],
    ['SELECT a FROM t WHERE x > ALL (SELECT -$1)', 'SELECT a FROM t WHERE x > ALL (SELECT ?)'],
    ['SELECT a - 1 FROM t', 'SELECT a - ? FROM t'],
    ['SELECT (a) - 1, b-2 FROM t', 'SELECT (a) - ?, b - ? FROM t'],
  ])('folds a unary sign into its literal but keeps a binary one: %s', (input, sql) =>
    expect(fingerprintSql(input, plain)!.sql).toBe(sql));

  it('TRUE and FALSE are literals; NULL and DEFAULT stay', () => {
    expect(fingerprintSql('UPDATE t SET a = TRUE, b = false, c = NULL, d = DEFAULT', plain)!.sql)
      .toBe('UPDATE t SET a = ?, b = ?, c = NULL, d = DEFAULT');
    expect(fingerprintSql('SELECT 1 FROM t WHERE a = TRUE', plain)!.hash).toBe(fingerprintSql('SELECT 1 FROM t WHERE a = false', plain)!.hash);
  });

  it.each([
    ['SELECT a FROM t WHERE id IN ($1::uuid, $2::uuid)', 'SELECT a FROM t WHERE id IN (?::uuid)'],
    ['SELECT a FROM t WHERE id = ANY (ARRAY[$1::int, $2::int, $3::int])', 'SELECT a FROM t WHERE id = ANY (ARRAY[?::int])'],
    ['SELECT a FROM t WHERE r IN ($1::"public"."Role", $2::"public"."Role")', 'SELECT a FROM t WHERE r IN (?::"public"."Role")'],
    ['SELECT a FROM t WHERE id IN (-1::int, 2::int)', 'SELECT a FROM t WHERE id IN (?::int)'],
  ])('collapses lists of typed placeholders: %s', (input, sql) => expect(fingerprintSql(input, plain)!.sql).toBe(sql));

  it('does not collapse a list holding anything but placeholders', () =>
    expect(fingerprintSql('SELECT a FROM t WHERE id IN ($1, b)', plain)!.sql).toBe('SELECT a FROM t WHERE id IN (?, b)'));

  it('hash is sha256 of the source prefix and the normalised SQL', () => {
    const f = fingerprintSql('SELECT 1', plain)!;
    expect(f.hash).toBe(createHash('sha256').update('postgresql\nSELECT ?').digest('hex').slice(0, 16));
  });

  it('the same statement with different values, spacing, case and comments has one hash', () => {
    const variants = [
      `SELECT a, b FROM t WHERE id = 1 AND name IN ('x', 'y')`,
      `select   A,b\n from T where ID=42 and NAME in ($1)`,
      `/* app=web */ SeLeCt a , b FROM t WHERE id = $1 -- note\n AND name IN ($2, $3, $4)`,
      `SELECT a,b FROM t WHERE id = E'\\x' AND name IN ($$p$$)`,
    ];
    const hashes = new Set(variants.map((v) => fingerprintSql(v, plain)!.hash));
    expect(hashes.size).toBe(1);
  });

  it('caps sql at 16,384 chars with a … marker, while the hash covers the whole text', () => {
    const a = fingerprintSql(`SELECT ${'a, '.repeat(9000)}b FROM t`, plain)!;
    const b = fingerprintSql(`SELECT ${'a, '.repeat(9000)}c FROM t`, plain)!;
    expect(a.sql).toHaveLength(MAX_SQL_CHARS); expect(a.sql.endsWith('…')).toBe(true); expect(a.hash).not.toBe(b.hash);
  });

  it('an input over 256 KiB is fingerprinted deterministically', () => {
    const text = `SELECT ${'col, '.repeat(75_000)}x FROM t`;
    expect(text.length).toBeGreaterThan(MAX_INPUT_CHARS);
    const a = fingerprintSql(text, plain)!;
    const b = fingerprintSql(text, plain)!;
    expect(a.hash).toBe(b.hash);
    expect(a.sql.endsWith('…')).toBe(true);
    expect(a.sql).toHaveLength(MAX_SQL_CHARS);
    const cut = fingerprintSql(`SELECT ${'col, '.repeat(75_000)}y FROM t`, plain)!;
    expect(cut.hash).toBe(a.hash);
    expect(fingerprintSql(text.slice(0, MAX_INPUT_CHARS), plain)!.hash).not.toBe(a.hash);
  });

  it('stays bounded on adversarial input', () => {
    const inputs = ['SELECT 1 FROM t WHERE x IN ('.repeat(20_000), `INSERT INTO t VALUES ${'VALUES ('.repeat(30_000)}`,
      `SELECT ARRAY[${'?, '.repeat(80_000)}`, `WITH ${'a AS ('.repeat(40_000)}`, `SELECT ${"'x".repeat(130_000)}`, '('.repeat(300_000),
      `SELECT 1 ${'+'.repeat(200_000)}`, `SELECT 1 <${'+-'.repeat(100_000)}`];
    const start = performance.now();
    for (const s of inputs) expect(() => fingerprintSql(s, { maskIdentifiers: true })).not.toThrow();
    expect(performance.now() - start).toBeLessThan(3_000);
  });

  it('never throws on random input', () => {
    let seed = 7;
    const rand = (): number => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    const alphabet = `'"$-/*()[]:;,.eEINSELECTVALUSARY ,?0123456789\n`;
    for (let i = 0; i < 3_000; i++) {
      let s = '';
      const len = Math.floor(rand() * 50);
      for (let j = 0; j < len; j++) s += alphabet[Math.floor(rand() * alphabet.length)];
      expect(() => fingerprintSql(s, { maskIdentifiers: i % 2 === 0 })).not.toThrow();
    }
  });
});

describe('createFingerprinter', () => {
  it('the fingerprinter caches by raw text and evicts the oldest', () => {
    const spy = vi.mocked(lex);
    spy.mockClear();
    const fp = createFingerprinter({ maskIdentifiers: false, maxEntries: 2 });
    const a = fp('SELECT 1');
    fp('SELECT 2 FROM b');
    expect(fp('SELECT 1')).toBe(a);
    expect(spy).toHaveBeenCalledTimes(2);
    fp('SELECT 3 FROM c');
    expect(spy).toHaveBeenCalledTimes(3);
    fp('SELECT 1');
    expect(spy).toHaveBeenCalledTimes(3);
    fp('SELECT 2 FROM b');
    expect(spy).toHaveBeenCalledTimes(4);
  });

  it('caches null results and skips texts over 16,384 characters', () => {
    const spy = vi.mocked(lex);
    spy.mockClear();
    const fp = createFingerprinter({ maskIdentifiers: false });
    expect(fp('BEGIN')).toBeNull();
    expect(fp('BEGIN')).toBeNull();
    expect(spy).toHaveBeenCalledTimes(1);
    const long = `SELECT ${'a'.repeat(16_400)}`;
    fp(long); fp(long);
    expect(spy).toHaveBeenCalledTimes(3);
  });

  it('honours the masking option', () =>
    expect(createFingerprinter({ maskIdentifiers: true })('SELECT a FROM t')!.sql).toBe(`SELECT ${maskName('a')} FROM ${maskName('t')}`));
});

describe('maskIdentifiers', () => {
  const PRISMA = `SELECT "public"."Patient"."ssn", COUNT(*) AS "_count$_all" FROM "public"."Patient" WHERE "public"."Patient"."email" = $1 AND lower(nick) = $2 AND x::text = $3 GROUP BY 1`;

  it('maskName is t_ plus 8 hex characters of sha256', () => {
    expect(maskName('Patient')).toBe(`t_${sha('Patient').slice(0, 8)}`);
    expect(maskName('Patient')).toMatch(/^t_[0-9a-f]{8}$/);
  });

  it('masks every schema, table, column and alias, keeps keywords, known functions and cast types', () => {
    const f = fingerprintSql(PRISMA, { maskIdentifiers: true })!;
    for (const secret of ['public', 'Patient', 'ssn', '_count', 'email', 'nick', '"']) expect(f.sql).not.toContain(secret);
    expect(f.sql).toBe(`SELECT ${maskName('public')}.${maskName('Patient')}.${maskName('ssn')}, count(*) AS ${maskName('_count$_all')} FROM ${maskName('public')}.${maskName('Patient')} WHERE ${maskName('public')}.${maskName('Patient')}.${maskName('email')} = ? AND lower(${maskName('nick')}) = ? AND ${maskName('x')}::text = ? GROUP BY ?`);
    expect(f.table).toBe(maskName('Patient'));
  });

  it('an unquoted name and the same name quoted in lower case mask alike', () =>
    expect(fingerprintSql('SELECT a FROM Users', { maskIdentifiers: true })!.sql).toBe(fingerprintSql('SELECT "a" FROM "users"', { maskIdentifiers: true })!.sql));

  it('a quoted name with doubled quotes is unquoted before masking', () =>
    expect(fingerprintSql('SELECT 1 FROM "My ""T"""', { maskIdentifiers: true })!.table).toBe(maskName('My "T"')));

  it('masks unknown functions and unterminated quoted identifiers leak nothing', () => {
    const f = fingerprintSql('SELECT secret_fn(a) FROM t WHERE "half', { maskIdentifiers: true })!;
    expect(f.sql).toBe(`SELECT ${maskName('secret_fn')}(${maskName('a')}) FROM ${maskName('t')} WHERE ?`);
  });

  it('masking changes the hash', () => {
    const masked = fingerprintSql(PRISMA, { maskIdentifiers: true })!;
    const unmasked = fingerprintSql(PRISMA, { maskIdentifiers: false })!;
    expect(masked.hash).not.toBe(unmasked.hash);
    expect(masked.verb).toBe('select');
  });
});
