import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Shared plumbing for the Prisma matrix (Task 19). Each fixture under prisma-fixtures/ is its own
 * npm project (installed by `pnpm --filter @query-analyser/sdk-compat prisma:setup`) with its own
 * prisma, @prisma/client, @prisma/adapter-pg, @prisma/instrumentation, pg and OpenTelemetry copies.
 * Everything is loaded with a require rooted in the fixture, so each row runs its own versions.
 */

const ROOT = fileURLToPath(new URL('../prisma-fixtures/', import.meta.url));

export interface Fixture {
  name: string;
  major: 5 | 6 | 7;
  dir: string;
  hasTracingClient: boolean;
  /** The exact Prisma version installed (every @prisma/* package and the CLI). */
  prisma: string;
  /** The app's own pg version. */
  pg: string;
}

export const FIXTURES: readonly Fixture[] = [
  { name: 'p522', major: 5, prisma: '5.22.0', pg: '8.11.6', hasTracingClient: true },
  { name: 'p601', major: 6, prisma: '6.0.1', pg: '8.13.3', hasTracingClient: true },
  { name: 'p619', major: 6, prisma: '6.19.3', pg: '8.16.3', hasTracingClient: false },
  { name: 'p710', major: 7, prisma: '7.10.1', pg: '8.23.1', hasTracingClient: false },
  { name: 'p710-private', major: 7, prisma: '7.10.1', pg: '8.11.6', hasTracingClient: false },
].map((f) => ({ ...f, major: f.major as 5 | 6 | 7, dir: join(ROOT, f.name) }));

/** `createRequire(join(dir, 'x.js')).resolve(name)`, or null when it does not resolve. */
export function resolverAt(dir: string): (name: string) => string | null {
  const req = createRequire(join(dir, 'x.js'));
  return (name: string) => {
    try {
      return req.resolve(name);
    } catch {
      return null;
    }
  };
}

/* eslint-disable @typescript-eslint/no-explicit-any */
export interface Loaded {
  PrismaClient: any;
  PrismaPg: any;
  pg: any;
  /** The pg that @prisma/adapter-pg itself loads (the app's copy, or the adapter's private one). */
  adapterPg: any;
  instrumentation: any;
  otel: { api: any; base: any; ctx: any };
}

/** The fixture's generated client (`client` or the 5.22/6.0 `tracing` one) and its own packages. */
export function load(fx: { dir: string }, client: 'client' | 'tracing' = 'client'): Loaded {
  const req = createRequire(join(fx.dir, 'x.js'));
  const gen = req(join(fx.dir, 'generated', client)) as { PrismaClient: any };
  const adapterEntry = req.resolve('@prisma/adapter-pg');
  return {
    PrismaClient: gen.PrismaClient,
    PrismaPg: (req('@prisma/adapter-pg') as { PrismaPg: any }).PrismaPg,
    pg: req('pg'),
    adapterPg: createRequire(adapterEntry)('pg'),
    instrumentation: req('@prisma/instrumentation'),
    otel: {
      api: req('@opentelemetry/api'),
      base: req('@opentelemetry/sdk-trace-base'),
      ctx: req('@opentelemetry/context-async-hooks'),
    },
  };
}

/**
 * The fixture's own CLI `db push` (with --skip-generate on 5/6, which 7 no longer has) against `url`.
 * DATABASE_URL goes in the child's env only; the CLI's output is discarded, so no URL is printed.
 */
export async function pushSchema(fx: { dir: string }, url: string): Promise<void> {
  const major = Number(((createRequire(join(fx.dir, 'x.js'))('prisma/package.json')) as { version: string }).version.split('.')[0]);
  const args = [join(fx.dir, 'node_modules', 'prisma', 'build', 'index.js'), 'db', 'push', ...(major < 7 ? ['--skip-generate'] : [])];
  const env = { ...process.env, DATABASE_URL: url, CHECKPOINT_DISABLE: '1', PRISMA_HIDE_UPDATE_MESSAGE: '1' };
  const code = await new Promise<number | null>((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: fx.dir, env, stdio: 'ignore' });
    child.on('error', reject);
    child.on('exit', (c) => resolve(c));
  });
  if (code !== 0) throw new Error(`prisma-harness: db push failed in ${fx.dir} (exit ${String(code)})`);
}

/** A per-process run id, so repeated workloads on one database never collide on unique columns. */
const RUN = `${process.pid.toString(36)}${Date.now().toString(36)}`;
let seq = 0;
const uniq = (): string => `${RUN}_${++seq}`;
/** The email of the user the last `create` made; findUnique and the interactive transaction read it. */
let lastEmail = '';

/** 12 Prisma calls covering the shapes the SDK must count: one entry per call, run in order. */
export const WORKLOAD: readonly { label: string; run(p: any): Promise<unknown> }[] = [
  {
    label: 'create',
    run: (p) => {
      lastEmail = `u_${uniq()}@x.test`;
      return p.user.create({ data: { email: lastEmail, name: 'n', posts: { create: { title: 'hello world', views: 1 } } } });
    },
  },
  { label: 'findUnique', run: (p) => p.user.findUnique({ where: { email: lastEmail } }) },
  { label: 'findMany include', run: (p) => p.user.findMany({ where: { email: lastEmail }, include: { posts: true }, take: 5 }) },
  { label: 'count', run: (p) => p.user.count() },
  { label: 'aggregate', run: (p) => p.post.aggregate({ _avg: { views: true }, _max: { views: true } }) },
  { label: 'groupBy', run: (p) => p.post.groupBy({ by: ['authorId'], _count: { _all: true } }) },
  { label: 'updateMany', run: (p) => p.post.updateMany({ where: { views: { gte: 1000 } }, data: { views: { increment: 1 } } }) },
  {
    label: 'upsert',
    run: (p) => {
      const sku = `up_${uniq()}`;
      return p.product.upsert({ where: { sku }, create: { sku, name: 'u', price: 1 }, update: { price: 2 } });
    },
  },
  {
    label: 'createMany',
    run: (p) => {
      const s = uniq();
      return p.product.createMany({ data: [1, 2, 3].map((i) => ({ sku: `cm_${s}_${i}`, name: 'p', price: i })) });
    },
  },
  { label: '$transaction batch', run: (p) => p.$transaction([p.user.count(), p.product.count()]) },
  {
    label: 'interactive $transaction',
    run: (p) =>
      p.$transaction(async (tx: any) => {
        const u = await tx.user.findUnique({ where: { email: lastEmail } });
        return tx.post.create({ data: { title: 'in tx', authorId: u.id } });
      }),
  },
  { label: '$queryRaw', run: (p) => p.$queryRaw`SELECT COUNT(*)::int AS n FROM "Product" WHERE "price" > ${0}` },
];
/* eslint-enable @typescript-eslint/no-explicit-any */

/** The verbs the SDK captures (design: statement filter S3). */
const CAPTURED = new Set(['select', 'insert', 'update', 'delete', 'merge', 'with', 'values', 'table', 'call']);

/** The first keyword after leading whitespace and comments, lower-cased. */
export function firstKeyword(sql: string): string {
  const rest = sql.replace(/^(?:\s+|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)*/, '');
  return (/^[A-Za-z]+/.exec(rest)?.[0] ?? '').toLowerCase();
}

/** Prisma's own `$on('query')` events whose first keyword is a captured verb. Reads only `query`. */
export function referenceCount(queryEvents: { query: string }[]): number {
  return queryEvents.filter((e) => CAPTURED.has(firstKeyword(e.query))).length;
}
