import { describe, it, expect } from 'vitest';
import { fingerprintSql } from './fingerprint.js';

// Prisma SQL per supported line, written from spike Q4 (2026-10-31-sql-prisma-spike.md).
// Task 19 replaces these texts with the ones recorded from the real fixtures if they differ.
// Each golden hash was computed independently: sha256('postgresql\n' + sql).hex.slice(0, 16).

const FIND_UNIQUE = {
  text: `SELECT "public"."User"."id", "public"."User"."email", "public"."User"."name" FROM "public"."User" WHERE ("public"."User"."id" = $1 AND 1=1) LIMIT $2 OFFSET $3`,
  sql: `SELECT "public"."User"."id", "public"."User"."email", "public"."User"."name" FROM "public"."User" WHERE ("public"."User"."id" = ? AND ? = ?) LIMIT ? OFFSET ?`,
  hash: '637b8b9d55a9edda', verb: 'select', table: 'User',
};
const FIND_MANY_INCLUDE = {
  text: `SELECT "public"."Post"."id", "public"."Post"."title", "public"."Post"."authorId" FROM "public"."Post" WHERE "public"."Post"."authorId" IN ($1,$2,$3) OFFSET $4`,
  sql: `SELECT "public"."Post"."id", "public"."Post"."title", "public"."Post"."authorId" FROM "public"."Post" WHERE "public"."Post"."authorId" IN (?) OFFSET ?`,
  hash: '9304f33a89c1f3b0', verb: 'select', table: 'Post',
};
const COUNT_5 = {
  text: `SELECT COUNT(*) FROM (SELECT "public"."User"."id" FROM "public"."User" WHERE 1=1 OFFSET $1) AS "sub"`,
  sql: `SELECT count(*) FROM (SELECT "public"."User"."id" FROM "public"."User" WHERE ? = ? OFFSET ?) AS "sub"`,
  hash: 'fb9bdfe157d66a7a', verb: 'select', table: null,
};
const COUNT_6 = {
  text: `SELECT COUNT(*) AS "_count$_all" FROM (SELECT "public"."User"."id" FROM "public"."User" WHERE 1=1 OFFSET $1) AS "sub"`,
  sql: `SELECT count(*) AS "_count$_all" FROM (SELECT "public"."User"."id" FROM "public"."User" WHERE ? = ? OFFSET ?) AS "sub"`,
  hash: 'cb381ff29c3dd7c3', verb: 'select', table: null,
};
const CREATE_MANY = {
  text: `INSERT INTO "public"."Product" ("sku","name","price") VALUES ($1,$2,$3), ($4,$5,$6), ($7,$8,$9)`,
  sql: `INSERT INTO "public"."Product" ("sku", "name", "price") VALUES (?, ?, ?)`,
  hash: 'be3b790c88760d4f', verb: 'insert', table: 'Product',
};
const CONTAINS_6 = {
  text: `SELECT "public"."Post"."id", "public"."Post"."title" FROM "public"."Post" WHERE "public"."Post"."title"::text LIKE $1 OFFSET $2`,
  sql: `SELECT "public"."Post"."id", "public"."Post"."title" FROM "public"."Post" WHERE "public"."Post"."title"::text LIKE ? OFFSET ?`,
  hash: 'dcce0943a99f558a', verb: 'select', table: 'Post',
};
const CONTAINS_7 = {
  text: `SELECT "public"."Post"."id", "public"."Post"."title" FROM "public"."Post" WHERE "public"."Post"."title"::text LIKE ($1 || $2 || $3) OFFSET $4`,
  sql: `SELECT "public"."Post"."id", "public"."Post"."title" FROM "public"."Post" WHERE "public"."Post"."title"::text LIKE (? || ? || ?) OFFSET ?`,
  hash: 'c394f0d6eba776e5', verb: 'select', table: 'Post',
};

const CORPUS = [
  ['5.22 engine', 'findUnique', FIND_UNIQUE], ['5.22 engine', 'findMany include', FIND_MANY_INCLUDE],
  ['5.22 engine', 'count', COUNT_5], ['5.22 engine', 'createMany', CREATE_MANY],
  ['6.19 engine', 'findUnique', FIND_UNIQUE], ['6.19 engine', 'findMany include', FIND_MANY_INCLUDE],
  ['6.19 engine', 'count', COUNT_6], ['6.19 engine', 'createMany', CREATE_MANY], ['6.19 engine', 'contains', CONTAINS_6],
  ['7.10 adapter', 'findUnique', FIND_UNIQUE], ['7.10 adapter', 'findMany include', FIND_MANY_INCLUDE],
  ['7.10 adapter', 'count', COUNT_6], ['7.10 adapter', 'createMany', CREATE_MANY], ['7.10 adapter', 'contains', CONTAINS_7],
] as const;

describe('corpus', () => {
  it.each(CORPUS)('Prisma SQL of each major normalises to its golden output (%s %s)', (_line, _call, c) => {
    expect(fingerprintSql(c.text, { maskIdentifiers: false })).toEqual({ sql: c.sql, hash: c.hash, verb: c.verb, table: c.table });
  });

  it('the createMany shape does not depend on the row count', () => {
    const one = fingerprintSql(`INSERT INTO "public"."Product" ("sku","name","price") VALUES ($1,$2,$3)`, { maskIdentifiers: false })!;
    expect(one.hash).toBe(CREATE_MANY.hash);
  });
});
