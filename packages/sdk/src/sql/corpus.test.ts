import { describe, it, expect } from 'vitest';
import { fingerprintSql } from './fingerprint.js';

// Prisma SQL recorded from the real Prisma lines (Task 19, packages/sdk-compat/prisma-fixtures):
// 5.22.0 and 6.19.3 from `$on('query')` on the engine path, 7.10.1 from the text `@prisma/adapter-pg`
// hands to pg's Client.prototype.query. Schema: User { id, email, name, posts }, Post { id, title,
// views, authorId, tags }, Product { id, sku, name, price }. Calls: findUnique by id; findMany
// { where: { id: { in: [3 ids] } }, include: { posts: true } } (its Post statement); count();
// createMany of 3 Products; findMany { where: { title: { contains } }, select: { id, title } }.
// Each golden hash was computed independently: sha256('postgresql\n' + sql).hex.slice(0, 16).

type Case = { text: string; sql: string; hash: string; verb: string; table: string | null };

const FIND_UNIQUE: Case = {
  text: `SELECT "public"."User"."id", "public"."User"."email", "public"."User"."name" FROM "public"."User" WHERE ("public"."User"."id" = $1 AND 1=1) LIMIT $2 OFFSET $3`,
  sql: `SELECT "public"."User"."id", "public"."User"."email", "public"."User"."name" FROM "public"."User" WHERE ("public"."User"."id" = ? AND ? = ?) LIMIT ? OFFSET ?`,
  hash: '637b8b9d55a9edda', verb: 'select', table: 'User',
};
const FIND_MANY_INCLUDE: Case = {
  text: `SELECT "public"."Post"."id", "public"."Post"."title", "public"."Post"."views", "public"."Post"."authorId" FROM "public"."Post" WHERE "public"."Post"."authorId" IN ($1,$2,$3) OFFSET $4`,
  sql: `SELECT "public"."Post"."id", "public"."Post"."title", "public"."Post"."views", "public"."Post"."authorId" FROM "public"."Post" WHERE "public"."Post"."authorId" IN (?) OFFSET ?`,
  hash: '4d6d3dc23436c8bc', verb: 'select', table: 'Post',
};
const COUNT_5: Case = {
  text: `SELECT COUNT(*) FROM (SELECT "public"."User"."id" FROM "public"."User" WHERE 1=1 OFFSET $1) AS "sub"`,
  sql: `SELECT count(*) FROM (SELECT "public"."User"."id" FROM "public"."User" WHERE ? = ? OFFSET ?) AS "sub"`,
  hash: 'fb9bdfe157d66a7a', verb: 'select', table: null,
};
const COUNT_6: Case = {
  text: `SELECT COUNT(*) AS "_count$_all" FROM (SELECT "public"."User"."id" FROM "public"."User" WHERE 1=1 OFFSET $1) AS "sub"`,
  sql: `SELECT count(*) AS "_count$_all" FROM (SELECT "public"."User"."id" FROM "public"."User" WHERE ? = ? OFFSET ?) AS "sub"`,
  hash: 'cb381ff29c3dd7c3', verb: 'select', table: null,
};
// Prisma <= 6.1 emits createMany's columns in a random order per call (spike Q6); this is the order recorded on 5.22.0.
const CREATE_MANY_5: Case = {
  text: `INSERT INTO "public"."Product" ("price","sku","name") VALUES ($1,$2,$3), ($4,$5,$6), ($7,$8,$9)`,
  sql: `INSERT INTO "public"."Product" ("price", "sku", "name") VALUES (?, ?, ?)`,
  hash: 'a466fa4f34350e03', verb: 'insert', table: 'Product',
};
const CREATE_MANY: Case = {
  text: `INSERT INTO "public"."Product" ("sku","name","price") VALUES ($1,$2,$3), ($4,$5,$6), ($7,$8,$9)`,
  sql: `INSERT INTO "public"."Product" ("sku", "name", "price") VALUES (?, ?, ?)`,
  hash: 'be3b790c88760d4f', verb: 'insert', table: 'Product',
};
const CONTAINS_ENGINE: Case = {
  text: `SELECT "public"."Post"."id", "public"."Post"."title" FROM "public"."Post" WHERE "public"."Post"."title"::text LIKE $1 OFFSET $2`,
  sql: `SELECT "public"."Post"."id", "public"."Post"."title" FROM "public"."Post" WHERE "public"."Post"."title"::text LIKE ? OFFSET ?`,
  hash: 'dcce0943a99f558a', verb: 'select', table: 'Post',
};
const CONTAINS_7: Case = {
  text: `SELECT "public"."Post"."id", "public"."Post"."title" FROM "public"."Post" WHERE "public"."Post"."title"::text LIKE ('%' || $1 || '%') OFFSET $2`,
  sql: `SELECT "public"."Post"."id", "public"."Post"."title" FROM "public"."Post" WHERE "public"."Post"."title"::text LIKE (? || ? || ?) OFFSET ?`,
  hash: 'c394f0d6eba776e5', verb: 'select', table: 'Post',
};

const CORPUS: readonly (readonly [string, string, Case])[] = [
  ['5.22 engine', 'findUnique', FIND_UNIQUE], ['5.22 engine', 'findMany include', FIND_MANY_INCLUDE],
  ['5.22 engine', 'count', COUNT_5], ['5.22 engine', 'createMany', CREATE_MANY_5], ['5.22 engine', 'contains', CONTAINS_ENGINE],
  ['6.19 engine', 'findUnique', FIND_UNIQUE], ['6.19 engine', 'findMany include', FIND_MANY_INCLUDE],
  ['6.19 engine', 'count', COUNT_6], ['6.19 engine', 'createMany', CREATE_MANY], ['6.19 engine', 'contains', CONTAINS_ENGINE],
  ['7.10 adapter', 'findUnique', FIND_UNIQUE], ['7.10 adapter', 'findMany include', FIND_MANY_INCLUDE],
  ['7.10 adapter', 'count', COUNT_6], ['7.10 adapter', 'createMany', CREATE_MANY], ['7.10 adapter', 'contains', CONTAINS_7],
];

describe('corpus', () => {
  it.each(CORPUS)('Prisma SQL of each line normalises to its golden output (%s %s)', (_line, _call, c) => {
    expect(fingerprintSql(c.text, { maskIdentifiers: false })).toEqual({ sql: c.sql, hash: c.hash, verb: c.verb, table: c.table });
  });

  it('the createMany shape does not depend on the row count', () => {
    const one = fingerprintSql(`INSERT INTO "public"."Product" ("sku","name","price") VALUES ($1,$2,$3)`, { maskIdentifiers: false })!;
    expect(one.hash).toBe(CREATE_MANY.hash);
  });

  it('Decision 6: some hashes change across Prisma lines, others hold', () => {
    const fp = (c: Case): string => fingerprintSql(c.text, { maskIdentifiers: false })!.hash;
    expect(fp(COUNT_5)).not.toBe(fp(COUNT_6)); // 5.22 -> 6.19: count alias
    expect(fp(CONTAINS_ENGINE)).not.toBe(fp(CONTAINS_7)); // 6.19 -> 7.10: contains
    expect(fp(CREATE_MANY_5)).not.toBe(fp(CREATE_MANY)); // <= 6.1 random createMany column order
  });
});
