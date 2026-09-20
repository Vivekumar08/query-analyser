# query-analyser API Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Fastify + Prisma + PostgreSQL service that accepts batches from the published `@vivekumar08/query-analyser` SDK, stores them as hourly rollups, and exposes self-hosted auth, organizations, apps, ingest keys, invites and RBAC — deployable as one Docker image.

**Architecture:** One long-lived Node process (`apps/api`). Ingest is a single validated route that authenticates by hashed API key and writes each batch in two SQL statements (signature upsert, rollup upsert with accumulate semantics). Dashboard auth is argon2id + short-lived JWT access tokens + rotating refresh tokens in an httpOnly cookie, with tenancy enforced by a `requireRole` preHandler AND by `orgId` filters in every query. Plan 3 adds analysis and read APIs on top of the tables this plan creates.

**Tech Stack:** Node 20+, TypeScript 5.7, Fastify 5, Prisma 7 (`prisma-client` generator, `@prisma/adapter-pg`), PostgreSQL 17, zod 3 (same major as `packages/contract`), argon2, `@fastify/jwt`, `@fastify/cookie`, `@fastify/rate-limit`, `@fastify/compress` (request gzip), pino, vitest, Docker.

**Spec:** `docs/superpowers/specs/2026-09-20-query-analyser-design.md` — sections 5 (API), 6 (data model). Section 7 (analysis) is Plan 3.

## Global Constraints

- The wire contract is `ingestPayloadSchema` from `@query-analyser/contract`. The ingest route validates every body with it and nothing else. Note the SDK ships `thresholdMs` as a **nonnegative** int (0 allowed) and `hist` as exactly 8 ints.
- Ingest keys are `qa_live_` + 32 hex chars. Stored as SHA-256 hex; only the first 12 chars (`qa_live_abcd`) are kept as `prefix` for display. The full key is returned exactly once, at creation.
- Rollup upserts use accumulate semantics: `count += `, `totalMs += `, `maxMs = GREATEST`, `hist` element-wise add. This mirrors the SDK's `merge()` so concurrent batches from many instances combine without coordination.
- Roles: `OWNER > ADMIN > MEMBER > VIEWER`. `User.isPlatformAdmin` is separate and gates `/v1/admin/*` only.
- Every org-scoped Prisma query includes `orgId` (directly or via relation) in its `where`. The `requireRole` guard is defence in depth, not the only line.
- Passwords: argon2id. Access JWT lifetime 15 minutes. Refresh token lifetime 30 days, rotated on every use, stored hashed with a `familyId`; reuse of a consumed token revokes the whole family.
- Secrets come only from environment variables, validated at boot by `src/config.ts`. No secret is ever logged.
- Tests run against a real PostgreSQL at `DATABASE_URL` (a `docker compose` service is provided). Tables are truncated between tests. No mocking of Prisma.
- TypeScript `strict: true`, `noUncheckedIndexedAccess: true`. No `any` in exported signatures.
- Every task ends with a commit.

## Carry-overs from Plan 1 (for the implementer's awareness)

- The SDK's default endpoint is `https://ingest.query-analyser.dev/v1/ingest`. This plan serves `/v1/ingest`; DNS and TLS are deployment, not code.
- `$in` list cardinality is not sent by the SDK; `$elemMatch` classifies as `other`. Plan 3's index advice inherits that.
- The SDK gzips bodies over 1 KB. The ingest route MUST accept `Content-Encoding: gzip`.

---

### Task 1: API scaffold with health route and Docker

**Files:**
- Create: `apps/api/package.json`, `apps/api/tsconfig.json`, `apps/api/vitest.config.ts`, `apps/api/src/app.ts`, `apps/api/src/server.ts`, `apps/api/src/config.ts`, `apps/api/Dockerfile`, `apps/api/.dockerignore`, `docker-compose.yml` (repo root), `apps/api/.env.example`
- Test: `apps/api/src/app.test.ts`

**Interfaces:**
- Produces: `buildApp(opts?: { logger?: boolean }): Promise<FastifyInstance>` — the whole app without listening; tests use `app.inject()`. `loadConfig(env: NodeJS.ProcessEnv): Config` — zod-validated, throws on missing secrets.

- [ ] **Step 1: Package manifest and configs**

`apps/api/package.json`:
```json
{
  "name": "@query-analyser/api",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=20" },
  "scripts": {
    "dev": "tsx watch src/server.ts",
    "build": "tsc -p tsconfig.build.json",
    "start": "node dist/server.js",
    "test": "vitest run",
    "typecheck": "tsc --noEmit",
    "db:generate": "prisma generate",
    "db:migrate": "prisma migrate dev",
    "db:deploy": "prisma migrate deploy"
  },
  "dependencies": {
    "@fastify/compress": "^8.0.1",
    "@fastify/cookie": "^11.0.2",
    "@fastify/jwt": "^9.0.4",
    "@fastify/rate-limit": "^10.2.2",
    "@prisma/adapter-pg": "^7.10.0",
    "@prisma/client": "^7.10.0",
    "@query-analyser/contract": "workspace:*",
    "argon2": "^0.41.1",
    "fastify": "^5.2.1",
    "pg": "^8.13.1",
    "pino": "^9.6.0",
    "zod": "^3.24.1"
  },
  "devDependencies": {
    "@types/node": "^22.10.5",
    "@types/pg": "^8.11.10",
    "dotenv": "^16.4.7",
    "prisma": "^7.10.0",
    "tsx": "^4.19.2",
    "typescript": "^5.7.2",
    "vitest": "^2.1.8"
  }
}
```

If `pnpm install` reports that a pinned major does not exist for `@fastify/*`, use the latest major that is compatible with Fastify 5 and note it in the report; the plan's versions were checked on 2026-09-20 (`fastify 5.12`, `@fastify/rate-limit 11`, `@fastify/cookie 11`, `@fastify/jwt 10`, `@prisma/client 7.10`).

`apps/api/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "module": "NodeNext", "moduleResolution": "NodeNext", "types": ["node"], "outDir": "dist", "rootDir": "src" },
  "include": ["src", "prisma.config.ts"]
}
```

`apps/api/tsconfig.build.json`:
```json
{ "extends": "./tsconfig.json", "exclude": ["src/**/*.test.ts", "src/test"] }
```

`apps/api/vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: { environment: 'node', include: ['src/**/*.test.ts'], fileParallelism: false, testTimeout: 30_000 },
});
```
`fileParallelism: false` because every test file shares one Postgres database and truncates it.

`apps/api/.env.example`:
```
DATABASE_URL=postgresql://qa:qa@localhost:5432/qa
JWT_SECRET=change-me-32-bytes-minimum-please-really
COOKIE_SECRET=change-me-32-bytes-minimum-please-really
PORT=8080
LOG_LEVEL=info
```

`docker-compose.yml` at the repo root:
```yaml
services:
  postgres:
    image: postgres:17-alpine
    environment:
      POSTGRES_USER: qa
      POSTGRES_PASSWORD: qa
      POSTGRES_DB: qa
    ports: ["5432:5432"]
    volumes: ["qa-pg:/var/lib/postgresql/data"]
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U qa"]
      interval: 5s
      retries: 10
volumes:
  qa-pg:
```

- [ ] **Step 2: Write the failing test**

`apps/api/src/app.test.ts`:
```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildApp } from './app.js';
import type { FastifyInstance } from 'fastify';

let app: FastifyInstance;
beforeAll(async () => { app = await buildApp({ logger: false }); });
afterAll(async () => { await app.close(); });

describe('health', () => {
  it('answers 200 with status ok', async () => {
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
  });

  it('404s unknown routes as JSON', async () => {
    const res = await app.inject({ method: 'GET', url: '/nope' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: 'Not Found' });
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm install && pnpm --filter @query-analyser/api test`
Expected: FAIL — cannot resolve `./app.js`.

- [ ] **Step 4: Implement config, app, server**

`apps/api/src/config.ts`:
```ts
import { z } from 'zod';

const schema = z.object({
  DATABASE_URL: z.string().url(),
  JWT_SECRET: z.string().min(32),
  COOKIE_SECRET: z.string().min(32),
  PORT: z.coerce.number().int().positive().default(8080),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  NODE_ENV: z.string().default('development'),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const missing = parsed.error.issues.map((i) => i.path.join('.')).join(', ');
    throw new Error(`invalid configuration: ${missing}`);
  }
  return parsed.data;
}
```

`apps/api/src/app.ts`:
```ts
import Fastify, { type FastifyInstance } from 'fastify';
import { loadConfig, type Config } from './config.js';

export interface BuildOptions {
  logger?: boolean;
  config?: Config;
}

export async function buildApp(opts: BuildOptions = {}): Promise<FastifyInstance> {
  const config = opts.config ?? loadConfig();
  const app = Fastify({
    logger: opts.logger === false ? false : { level: config.LOG_LEVEL },
    trustProxy: true,
  });

  app.decorate('config', config);

  app.get('/healthz', async () => ({ status: 'ok' }));

  app.setNotFoundHandler((_req, reply) => {
    void reply.code(404).send({ error: 'Not Found' });
  });

  app.setErrorHandler((err, req, reply) => {
    const status = err.statusCode ?? 500;
    if (status >= 500) req.log.error({ err }, 'unhandled error');
    void reply.code(status).send({ error: status >= 500 ? 'Internal Server Error' : err.message });
  });

  return app;
}

declare module 'fastify' {
  interface FastifyInstance { config: Config; }
}
```

`apps/api/src/server.ts`:
```ts
import 'dotenv/config';
import { buildApp } from './app.js';

const app = await buildApp();
const { PORT } = app.config;

const shutdown = async (signal: string) => {
  app.log.info({ signal }, 'shutting down');
  await app.close();
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

await app.listen({ port: PORT, host: '0.0.0.0' });
```

(`dotenv` is a devDependency: in Docker, env comes from the platform. Move it to `dependencies` if you prefer `.env` in production; the plan keeps it dev-only.)

`apps/api/Dockerfile`:
```dockerfile
FROM node:22-alpine AS base
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate
WORKDIR /repo

FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json turbo.json tsconfig.base.json ./
COPY packages/contract/package.json packages/contract/
COPY apps/api/package.json apps/api/
RUN pnpm install --frozen-lockfile --filter @query-analyser/api...

FROM deps AS build
COPY packages/contract packages/contract
COPY apps/api apps/api
RUN pnpm --filter @query-analyser/api db:generate && pnpm --filter @query-analyser/api build

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=build /repo /repo
WORKDIR /repo/apps/api
EXPOSE 8080
CMD ["sh", "-c", "pnpm db:deploy && node dist/server.js"]
```

`apps/api/.dockerignore`:
```
node_modules
dist
.env
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cp apps/api/.env.example apps/api/.env && pnpm --filter @query-analyser/api test`
Expected: PASS (2 tests). No database is needed yet.

- [ ] **Step 6: Commit**

```bash
git add apps/api docker-compose.yml
git commit -m "feat(api): scaffold Fastify app with health route, config and Dockerfile"
```

---

### Task 2: Prisma 7 schema, migration, client and test database helper

**Files:**
- Create: `apps/api/prisma/schema.prisma`, `apps/api/prisma.config.ts`, `apps/api/src/db.ts`, `apps/api/src/test/db.ts`
- Modify: `.gitignore` (root) — add `apps/api/src/generated/`
- Test: `apps/api/src/db.test.ts`

**Interfaces:**
- Produces: `createPrisma(databaseUrl: string): PrismaClient` and the singleton `getPrisma()`; `resetDb(prisma): Promise<void>` for tests (truncates all tables); the full data model from spec §6.

- [ ] **Step 1: Prisma config and schema**

`apps/api/prisma.config.ts`:
```ts
import 'dotenv/config';
import { defineConfig, env } from 'prisma/config';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  datasource: { url: env('DATABASE_URL') },
});
```

`apps/api/prisma/schema.prisma`:
```prisma
generator client {
  provider = "prisma-client"
  output   = "../src/generated/prisma"
}

datasource db {
  provider = "postgresql"
}

// Prisma 7.10 REJECTS `url` here (P1012, verified against the real CLI — the
// upgrade guide is wrong on this). The connection string reaches the CLI
// through prisma.config.ts and the runtime through the PrismaPg adapter.

enum Role {
  OWNER
  ADMIN
  MEMBER
  VIEWER
}

enum AdviceStatus {
  OPEN
  APPLIED
  DISMISSED
}

model User {
  id              String         @id @default(uuid())
  email           String         @unique
  passwordHash    String
  name            String
  isPlatformAdmin Boolean        @default(false)
  createdAt       DateTime       @default(now())
  memberships     Membership[]
  refreshTokens   RefreshToken[]
}

model Organization {
  id          String       @id @default(uuid())
  name        String
  slug        String       @unique
  plan        String       @default("free")
  suspendedAt DateTime?
  createdAt   DateTime     @default(now())
  memberships Membership[]
  apps        App[]
  invites     Invite[]
}

model Membership {
  id        String       @id @default(uuid())
  userId    String
  orgId     String
  role      Role
  createdAt DateTime     @default(now())
  user      User         @relation(fields: [userId], references: [id], onDelete: Cascade)
  org       Organization @relation(fields: [orgId], references: [id], onDelete: Cascade)

  @@unique([userId, orgId])
  @@index([orgId])
}

model Invite {
  id         String       @id @default(uuid())
  orgId      String
  email      String
  role       Role
  tokenHash  String       @unique
  expiresAt  DateTime
  acceptedAt DateTime?
  createdAt  DateTime     @default(now())
  org        Organization @relation(fields: [orgId], references: [id], onDelete: Cascade)

  @@index([orgId])
}

model RefreshToken {
  id         String    @id @default(uuid())
  userId     String
  familyId   String
  tokenHash  String    @unique
  expiresAt  DateTime
  consumedAt DateTime?
  createdAt  DateTime  @default(now())
  user       User      @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@index([familyId])
  @@index([userId])
}

model App {
  id         String           @id @default(uuid())
  orgId      String
  name       String
  env        String
  createdAt  DateTime         @default(now())
  org        Organization     @relation(fields: [orgId], references: [id], onDelete: Cascade)
  keys       IngestKey[]
  signatures QuerySignature[]

  @@unique([orgId, name, env])
  @@index([orgId])
}

model IngestKey {
  id         String    @id @default(uuid())
  appId      String
  keyHash    String    @unique
  prefix     String
  lastUsedAt DateTime?
  revokedAt  DateTime?
  createdAt  DateTime  @default(now())
  app        App       @relation(fields: [appId], references: [id], onDelete: Cascade)

  @@index([appId])
}

model QuerySignature {
  id             String        @id @default(uuid())
  appId          String
  hash           String
  signature      String
  model          String
  operation      String
  filterShape    Json
  sortKeys       Json
  stages         String[]
  redactedSample Json?
  firstSeen      DateTime      @default(now())
  lastSeen       DateTime      @default(now())
  app            App           @relation(fields: [appId], references: [id], onDelete: Cascade)
  rollups        QueryRollup[]
  dailyRollups   QueryDailyRollup[]
  alerts         Alert[]
  advice         Advice?

  @@unique([appId, hash])
  @@index([appId, lastSeen])
}

model QueryRollup {
  id          String         @id @default(uuid())
  signatureId String
  bucketHour  DateTime
  count       Int
  totalMs     BigInt
  maxMs       Int
  hist        Int[]
  signature   QuerySignature @relation(fields: [signatureId], references: [id], onDelete: Cascade)

  @@unique([signatureId, bucketHour])
  @@index([bucketHour])
}

model QueryDailyRollup {
  id          String         @id @default(uuid())
  signatureId String
  day         DateTime
  count       Int
  totalMs     BigInt
  maxMs       Int
  hist        Int[]
  signature   QuerySignature @relation(fields: [signatureId], references: [id], onDelete: Cascade)

  @@unique([signatureId, day])
  @@index([day])
}

model Alert {
  id             String         @id @default(uuid())
  signatureId    String
  kind           String
  detectedAt     DateTime       @default(now())
  details        Json
  acknowledgedAt DateTime?
  signature      QuerySignature @relation(fields: [signatureId], references: [id], onDelete: Cascade)

  @@index([signatureId, detectedAt])
}

model Advice {
  id          String         @id @default(uuid())
  signatureId String         @unique
  suggestion  Json
  rationale   String
  status      AdviceStatus   @default(OPEN)
  updatedAt   DateTime       @updatedAt
  signature   QuerySignature @relation(fields: [signatureId], references: [id], onDelete: Cascade)
}
```

Add `apps/api/src/generated/` to the root `.gitignore`.

- [ ] **Step 2: Create the migration and generate the client**

Run (Postgres must be up: `docker compose up -d postgres`):
```bash
cd apps/api && pnpm prisma migrate dev --name init && pnpm prisma generate
```
Expected: `prisma/migrations/<timestamp>_init/migration.sql` created; `src/generated/prisma/` created (ignored by git).

- [ ] **Step 3: Write the failing test**

`apps/api/src/db.test.ts`:
```ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createPrisma } from './db.js';
import { resetDb } from './test/db.js';
import { loadConfig } from './config.js';

const prisma = createPrisma(loadConfig().DATABASE_URL);
beforeEach(async () => { await resetDb(prisma); });
afterAll(async () => { await prisma.$disconnect(); });

describe('database', () => {
  it('round-trips an organization', async () => {
    const org = await prisma.organization.create({ data: { name: 'Acme', slug: 'acme' } });
    expect(await prisma.organization.findUnique({ where: { id: org.id } })).toMatchObject({ slug: 'acme' });
  });

  it('resetDb empties every table', async () => {
    await prisma.organization.create({ data: { name: 'Acme', slug: 'acme' } });
    await resetDb(prisma);
    expect(await prisma.organization.count()).toBe(0);
  });

  it('enforces the (appId, hash) uniqueness on signatures', async () => {
    const org = await prisma.organization.create({ data: { name: 'A', slug: 'a' } });
    const app = await prisma.app.create({ data: { orgId: org.id, name: 'web', env: 'prod' } });
    const data = { appId: app.id, hash: 'h', signature: 's', model: 'M', operation: 'find', filterShape: [], sortKeys: [], stages: [] };
    await prisma.querySignature.create({ data });
    await expect(prisma.querySignature.create({ data })).rejects.toThrow();
  });
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `pnpm --filter @query-analyser/api test`
Expected: FAIL — cannot resolve `./db.js`.

- [ ] **Step 5: Implement the client and the reset helper**

`apps/api/src/db.ts`:
```ts
import { PrismaClient } from './generated/prisma/client.js';
import { PrismaPg } from '@prisma/adapter-pg';

export function createPrisma(connectionString: string): PrismaClient {
  const adapter = new PrismaPg({ connectionString });
  return new PrismaClient({ adapter });
}

let singleton: PrismaClient | null = null;
export function getPrisma(connectionString: string): PrismaClient {
  singleton ??= createPrisma(connectionString);
  return singleton;
}

export type { PrismaClient };
```

If the generated import path differs (Prisma 7 emits `client.ts` under the output directory; some versions expose it as `./generated/prisma/index.js`), use whatever `pnpm prisma generate` actually produced and note it in the report — do not hand-edit generated files.

`apps/api/src/test/db.ts`:
```ts
import type { PrismaClient } from '../db.js';

/** Truncate every application table. Order does not matter with CASCADE. */
export async function resetDb(prisma: PrismaClient): Promise<void> {
  const rows = await prisma.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'
  `;
  if (rows.length === 0) return;
  const list = rows.map((r) => `"${r.tablename}"`).join(', ');
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
}
```

`$executeRawUnsafe` is acceptable here only because the identifiers come from `pg_tables`, not from input, and this file is test-only (excluded from the build by `tsconfig.build.json`).

- [ ] **Step 6: Run test to verify it passes**

Run: `pnpm --filter @query-analyser/api test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/api/prisma apps/api/prisma.config.ts apps/api/src/db.ts apps/api/src/test apps/api/src/db.test.ts .gitignore
git commit -m "feat(api): add Prisma 7 schema, initial migration and test database helper"
```

---

### Task 3: Ingest key service

**Files:**
- Create: `apps/api/src/ingest/keys.ts`
- Test: `apps/api/src/ingest/keys.test.ts`

**Interfaces:**
- Produces: `generateKey(): { key: string; hash: string; prefix: string }`; `hashKey(key: string): string`; `class KeyResolver` with `constructor(prisma, ttlMs = 60_000)`, `resolve(key: string): Promise<ResolvedKey | null>` where `ResolvedKey = { keyId: string; appId: string; orgId: string; suspended: boolean }`, and `invalidate(hash: string): void`.

The resolver caches by hash for `ttlMs` so the hot path does not hit Postgres per batch. Revocation calls `invalidate`. A negative result (unknown key) is also cached, for the same TTL, so a wrong key cannot be used to hammer the database.

- [ ] **Step 1: Write the failing test**

`apps/api/src/ingest/keys.test.ts`:
```ts
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { createPrisma } from '../db.js';
import { resetDb } from '../test/db.js';
import { loadConfig } from '../config.js';
import { generateKey, hashKey, KeyResolver } from './keys.js';

const prisma = createPrisma(loadConfig().DATABASE_URL);
beforeEach(async () => { await resetDb(prisma); });
afterAll(async () => { await prisma.$disconnect(); });

async function seedApp() {
  const org = await prisma.organization.create({ data: { name: 'A', slug: 'a' } });
  return prisma.app.create({ data: { orgId: org.id, name: 'web', env: 'prod' } });
}

describe('generateKey', () => {
  it('produces qa_live_ + 32 hex, a sha256 hash and a 12-char prefix', () => {
    const k = generateKey();
    expect(k.key).toMatch(/^qa_live_[0-9a-f]{32}$/);
    expect(k.hash).toBe(hashKey(k.key));
    expect(k.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(k.prefix).toBe(k.key.slice(0, 12));
  });

  it('never repeats', () => {
    const seen = new Set(Array.from({ length: 100 }, () => generateKey().key));
    expect(seen.size).toBe(100);
  });
});

describe('KeyResolver', () => {
  it('resolves a stored key to its app and org', async () => {
    const app = await seedApp();
    const k = generateKey();
    await prisma.ingestKey.create({ data: { appId: app.id, keyHash: k.hash, prefix: k.prefix } });

    const r = new KeyResolver(prisma);
    expect(await r.resolve(k.key)).toEqual({ keyId: expect.any(String), appId: app.id, orgId: app.orgId, suspended: false });
  });

  it('returns null for an unknown or revoked key', async () => {
    const app = await seedApp();
    const k = generateKey();
    await prisma.ingestKey.create({ data: { appId: app.id, keyHash: k.hash, prefix: k.prefix, revokedAt: new Date() } });
    const r = new KeyResolver(prisma);
    expect(await r.resolve(k.key)).toBeNull();
    expect(await r.resolve('qa_live_' + 'f'.repeat(32))).toBeNull();
  });

  it('caches lookups for the TTL, including misses', async () => {
    const app = await seedApp();
    const k = generateKey();
    await prisma.ingestKey.create({ data: { appId: app.id, keyHash: k.hash, prefix: k.prefix } });
    const r = new KeyResolver(prisma, 60_000);
    const spy = vi.spyOn(prisma.ingestKey, 'findUnique');

    await r.resolve(k.key);
    await r.resolve(k.key);
    await r.resolve('qa_live_' + '0'.repeat(32));
    await r.resolve('qa_live_' + '0'.repeat(32));
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('reflects a suspended org', async () => {
    const app = await seedApp();
    await prisma.organization.update({ where: { id: app.orgId }, data: { suspendedAt: new Date() } });
    const k = generateKey();
    await prisma.ingestKey.create({ data: { appId: app.id, keyHash: k.hash, prefix: k.prefix } });
    expect(await new KeyResolver(prisma).resolve(k.key)).toMatchObject({ suspended: true });
  });

  it('invalidate() forces the next lookup to hit the database', async () => {
    const app = await seedApp();
    const k = generateKey();
    await prisma.ingestKey.create({ data: { appId: app.id, keyHash: k.hash, prefix: k.prefix } });
    const r = new KeyResolver(prisma);
    await r.resolve(k.key);
    await prisma.ingestKey.update({ where: { keyHash: k.hash }, data: { revokedAt: new Date() } });
    expect(await r.resolve(k.key)).not.toBeNull();   // still cached
    r.invalidate(k.hash);
    expect(await r.resolve(k.key)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @query-analyser/api test -- keys`
Expected: FAIL — cannot resolve `./keys.js`.

- [ ] **Step 3: Implement**

`apps/api/src/ingest/keys.ts`:
```ts
import { createHash, randomBytes } from 'node:crypto';
import type { PrismaClient } from '../db.js';

const PREFIX = 'qa_live_';

export function hashKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

export function generateKey(): { key: string; hash: string; prefix: string } {
  const key = PREFIX + randomBytes(16).toString('hex');
  return { key, hash: hashKey(key), prefix: key.slice(0, 12) };
}

export interface ResolvedKey {
  keyId: string;
  appId: string;
  orgId: string;
  suspended: boolean;
}

interface CacheEntry { value: ResolvedKey | null; expiresAt: number }

export class KeyResolver {
  private cache = new Map<string, CacheEntry>();

  constructor(private readonly prisma: PrismaClient, private readonly ttlMs = 60_000) {}

  async resolve(key: string): Promise<ResolvedKey | null> {
    if (!key.startsWith(PREFIX)) return null;
    const hash = hashKey(key);
    const hit = this.cache.get(hash);
    if (hit && hit.expiresAt > Date.now()) return hit.value;

    const row = await this.prisma.ingestKey.findUnique({
      where: { keyHash: hash },
      select: { id: true, revokedAt: true, app: { select: { id: true, orgId: true, org: { select: { suspendedAt: true } } } } },
    });

    const value: ResolvedKey | null = row && !row.revokedAt
      ? { keyId: row.id, appId: row.app.id, orgId: row.app.orgId, suspended: row.app.org.suspendedAt !== null }
      : null;

    this.cache.set(hash, { value, expiresAt: Date.now() + this.ttlMs });
    return value;
  }

  invalidate(hash: string): void {
    this.cache.delete(hash);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @query-analyser/api test -- keys`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/ingest
git commit -m "feat(api): add ingest key generation, hashing and cached resolver"
```

---

### Task 4: Rollup writer — the two-statement batch upsert

This is the hot write path. It is a pure function of `(prisma, appId, payload)` so it can be tested exhaustively without HTTP.

**Files:**
- Create: `apps/api/src/ingest/writer.ts`
- Test: `apps/api/src/ingest/writer.test.ts`

**Interfaces:**
- Consumes: `IngestPayload`, `IngestItem` types from `@query-analyser/contract`.
- Produces: `writeBatch(prisma, appId: string, payload: IngestPayload): Promise<{ signatures: number; rollups: number }>`; `bucketToDate(bucket: string): Date` (`'2026092014'` → `2026-09-20T14:00:00Z`).

- [ ] **Step 1: Write the failing test**

`apps/api/src/ingest/writer.test.ts`:
```ts
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { createPrisma } from '../db.js';
import { resetDb } from '../test/db.js';
import { loadConfig } from '../config.js';
import { writeBatch, bucketToDate } from './writer.js';
import type { IngestPayload, IngestItem } from '@query-analyser/contract';

const prisma = createPrisma(loadConfig().DATABASE_URL);
beforeEach(async () => { await resetDb(prisma); });
afterAll(async () => { await prisma.$disconnect(); });

async function seedApp() {
  const org = await prisma.organization.create({ data: { name: 'A', slug: 'a' } });
  return prisma.app.create({ data: { orgId: org.id, name: 'web', env: 'prod' } });
}

function item(over: Partial<IngestItem> = {}): IngestItem {
  return {
    signature: 'Order.find(status:eq)', hash: 'a'.repeat(16), model: 'Order', operation: 'find',
    filterShape: [{ key: 'status', op: 'eq' }], sortKeys: [], stages: [],
    count: 3, totalMs: 600, maxMs: 400, lastMs: 120, lastTs: 1758378000000,
    hist: [0, 2, 1, 0, 0, 0, 0, 0], sample: { filter: { status: '<string>' } },
    ...over,
  };
}

function payload(items: IngestItem[], bucket = '2026092014'): IngestPayload {
  return { app: 'web', env: 'prod', host: 'h', sdkVersion: '0.1.0', bucket, thresholdMs: 100, dropped: 0, items };
}

describe('bucketToDate', () => {
  it('parses YYYYMMDDHH as UTC', () => {
    expect(bucketToDate('2026092014').toISOString()).toBe('2026-09-20T14:00:00.000Z');
  });
});

describe('writeBatch', () => {
  it('creates a signature and a rollup for a new shape', async () => {
    const app = await seedApp();
    const res = await writeBatch(prisma, app.id, payload([item()]));
    expect(res).toEqual({ signatures: 1, rollups: 1 });

    const sig = await prisma.querySignature.findUniqueOrThrow({ where: { appId_hash: { appId: app.id, hash: 'a'.repeat(16) } } });
    expect(sig).toMatchObject({ model: 'Order', operation: 'find', stages: [] });
    expect(sig.redactedSample).toEqual({ filter: { status: '<string>' } });

    const roll = await prisma.queryRollup.findUniqueOrThrow({ where: { signatureId_bucketHour: { signatureId: sig.id, bucketHour: bucketToDate('2026092014') } } });
    expect(roll).toMatchObject({ count: 3, maxMs: 400, hist: [0, 2, 1, 0, 0, 0, 0, 0] });
    expect(roll.totalMs).toBe(600n);
  });

  it('accumulates a second batch into the same hour: count and total add, max is greatest, hist is element-wise', async () => {
    const app = await seedApp();
    await writeBatch(prisma, app.id, payload([item()]));
    await writeBatch(prisma, app.id, payload([item({ count: 2, totalMs: 1000, maxMs: 900, hist: [0, 0, 0, 1, 1, 0, 0, 0] })]));

    const sig = await prisma.querySignature.findFirstOrThrow({ where: { appId: app.id } });
    const roll = await prisma.queryRollup.findFirstOrThrow({ where: { signatureId: sig.id } });
    expect(roll).toMatchObject({ count: 5, maxMs: 900, hist: [0, 2, 1, 1, 1, 0, 0, 0] });
    expect(roll.totalMs).toBe(1600n);
  });

  it('keeps separate rows per hour', async () => {
    const app = await seedApp();
    await writeBatch(prisma, app.id, payload([item()], '2026092014'));
    await writeBatch(prisma, app.id, payload([item()], '2026092015'));
    expect(await prisma.queryRollup.count()).toBe(2);
  });

  it('updates lastSeen and the sample on an existing signature but keeps firstSeen', async () => {
    const app = await seedApp();
    await writeBatch(prisma, app.id, payload([item()]));
    const before = await prisma.querySignature.findFirstOrThrow({ where: { appId: app.id } });
    await new Promise((r) => setTimeout(r, 20));
    await writeBatch(prisma, app.id, payload([item({ sample: { filter: { status: '<string>', v: '<number>' } } })]));
    const after = await prisma.querySignature.findFirstOrThrow({ where: { appId: app.id } });
    expect(after.firstSeen.getTime()).toBe(before.firstSeen.getTime());
    expect(after.lastSeen.getTime()).toBeGreaterThan(before.lastSeen.getTime());
    expect(after.redactedSample).toEqual({ filter: { status: '<string>', v: '<number>' } });
  });

  it('writes many distinct signatures in one batch', async () => {
    const app = await seedApp();
    const items = Array.from({ length: 200 }, (_, i) => item({ hash: i.toString(16).padStart(16, '0'), signature: `S${i}` }));
    const res = await writeBatch(prisma, app.id, payload(items));
    expect(res).toEqual({ signatures: 200, rollups: 200 });
  });

  it('scopes signatures to the app — the same hash in two apps is two rows', async () => {
    const org = await prisma.organization.create({ data: { name: 'A', slug: 'a' } });
    const a = await prisma.app.create({ data: { orgId: org.id, name: 'a', env: 'prod' } });
    const b = await prisma.app.create({ data: { orgId: org.id, name: 'b', env: 'prod' } });
    await writeBatch(prisma, a.id, payload([item()]));
    await writeBatch(prisma, b.id, payload([item()]));
    expect(await prisma.querySignature.count()).toBe(2);
  });

  it('is safe under concurrent batches for the same signature and hour', async () => {
    const app = await seedApp();
    await Promise.all(Array.from({ length: 10 }, () => writeBatch(prisma, app.id, payload([item({ count: 1, totalMs: 100, hist: [0, 1, 0, 0, 0, 0, 0, 0] })]))));
    const roll = await prisma.queryRollup.findFirstOrThrow();
    expect(roll.count).toBe(10);
    expect(roll.hist[1]).toBe(10);
  });

  it('handles an empty items list as a no-op', async () => {
    const app = await seedApp();
    expect(await writeBatch(prisma, app.id, payload([]))).toEqual({ signatures: 0, rollups: 0 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @query-analyser/api test -- writer`
Expected: FAIL — cannot resolve `./writer.js`.

- [ ] **Step 3: Implement**

`apps/api/src/ingest/writer.ts`:
```ts
import { Prisma } from '../generated/prisma/client.js';
import type { PrismaClient } from '../db.js';
import type { IngestPayload } from '@query-analyser/contract';

export function bucketToDate(bucket: string): Date {
  const y = Number(bucket.slice(0, 4));
  const m = Number(bucket.slice(4, 6)) - 1;
  const d = Number(bucket.slice(6, 8));
  const h = Number(bucket.slice(8, 10));
  return new Date(Date.UTC(y, m, d, h));
}

/**
 * Two statements per batch:
 *  1. upsert signatures by (appId, hash), returning ids
 *  2. upsert rollups by (signatureId, bucketHour) with accumulate semantics
 * Both use jsonb_to_recordset so a batch of any size is one round-trip each.
 */
export async function writeBatch(
  prisma: PrismaClient,
  appId: string,
  payload: IngestPayload,
): Promise<{ signatures: number; rollups: number }> {
  if (payload.items.length === 0) return { signatures: 0, rollups: 0 };

  const now = new Date();
  const bucketHour = bucketToDate(payload.bucket);

  // Dedupe by hash within the batch (the SDK already does, but be safe).
  const byHash = new Map(payload.items.map((i) => [i.hash, i]));
  const items = [...byHash.values()];

  const sigRows = items.map((i) => ({
    appId,
    hash: i.hash,
    signature: i.signature,
    model: i.model,
    operation: i.operation,
    filterShape: i.filterShape,
    sortKeys: i.sortKeys,
    stages: i.stages,
    redactedSample: i.sample ?? null,
  }));

  const ids = await prisma.$queryRaw<{ id: string; hash: string }[]>`
    INSERT INTO "QuerySignature" ("id","appId","hash","signature","model","operation","filterShape","sortKeys","stages","redactedSample","firstSeen","lastSeen")
    SELECT gen_random_uuid(), t."appId", t.hash, t.signature, t.model, t.operation, t."filterShape", t."sortKeys", t.stages, t."redactedSample", ${now}, ${now}
    FROM jsonb_to_recordset(${JSON.stringify(sigRows)}::jsonb)
      AS t("appId" uuid, hash text, signature text, model text, operation text, "filterShape" jsonb, "sortKeys" jsonb, stages text[], "redactedSample" jsonb)
    ON CONFLICT ("appId","hash") DO UPDATE SET
      "lastSeen" = EXCLUDED."lastSeen",
      "redactedSample" = COALESCE(EXCLUDED."redactedSample", "QuerySignature"."redactedSample")
    RETURNING id, hash
  `;

  const idByHash = new Map(ids.map((r) => [r.hash, r.id]));

  const rollRows = items.map((i) => ({
    signatureId: idByHash.get(i.hash)!,
    bucketHour: bucketHour.toISOString(),
    count: i.count,
    totalMs: Math.round(i.totalMs),
    maxMs: Math.round(i.maxMs),
    hist: i.hist,
  }));

  const rollups = await prisma.$executeRaw`
    INSERT INTO "QueryRollup" ("id","signatureId","bucketHour","count","totalMs","maxMs","hist")
    SELECT gen_random_uuid(), t."signatureId", t."bucketHour", t.count, t."totalMs", t."maxMs", t.hist
    FROM jsonb_to_recordset(${JSON.stringify(rollRows)}::jsonb)
      AS t("signatureId" uuid, "bucketHour" timestamptz, count int, "totalMs" bigint, "maxMs" int, hist int[])
    ON CONFLICT ("signatureId","bucketHour") DO UPDATE SET
      "count"   = "QueryRollup"."count"   + EXCLUDED."count",
      "totalMs" = "QueryRollup"."totalMs" + EXCLUDED."totalMs",
      "maxMs"   = GREATEST("QueryRollup"."maxMs", EXCLUDED."maxMs"),
      "hist"    = ARRAY(SELECT a + b FROM unnest("QueryRollup"."hist", EXCLUDED."hist") AS u(a, b))
  `;

  return { signatures: ids.length, rollups };
}

// Referenced so tsc keeps the Prisma namespace import for future Prisma.sql use.
void Prisma;
```

Notes for the implementer:
- `gen_random_uuid()` is built into PostgreSQL 13+. No extension needed.
- If Prisma 7's tagged template rejects a `Date` parameter, pass `${now.toISOString()}::timestamptz` instead.
- `$executeRaw` returns the affected row count; for `INSERT ... ON CONFLICT DO UPDATE` PostgreSQL reports one per row whether inserted or updated, which is what the test expects.
- Remove the `void Prisma;` line and its import if the namespace is not used — it is only there to avoid an unused-import error if you end up needing `Prisma.sql`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @query-analyser/api test -- writer`
Expected: PASS (8 tests). The concurrent test is the one that proves the accumulate semantics hold under contention — if it is flaky, the SQL is wrong, not the test.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/ingest/writer.ts apps/api/src/ingest/writer.test.ts
git commit -m "feat(api): add two-statement rollup writer with accumulate upserts"
```

---

### Task 5: The ingest route — auth, gzip, validation, rate limit, quota

**Files:**
- Create: `apps/api/src/ingest/routes.ts`, `apps/api/src/plugins/prisma.ts`
- Modify: `apps/api/src/app.ts` (register plugins + routes)
- Test: `apps/api/src/ingest/routes.test.ts`

**Interfaces:**
- Consumes: `KeyResolver` (Task 3), `writeBatch` (Task 4), `ingestPayloadSchema` from `@query-analyser/contract`.
- Produces: `POST /v1/ingest` returning `202 { accepted: n }`; app decorations `app.prisma` and `app.keys`. Errors: 401 unknown/revoked key, 403 suspended org, 400 invalid body (`{ error, issues }`), 413 too large, 429 rate limit or quota.

Quota for v1: max 5000 distinct signatures per app (matches the SDK cap). Enforced by counting `QuerySignature` for the app when a batch introduces new hashes; over quota → 429 with `{ error: 'signature quota exceeded', limit }`.

- [ ] **Step 1: Write the failing test**

`apps/api/src/ingest/routes.test.ts`:
```ts
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { gzipSync } from 'node:zlib';
import { buildApp } from '../app.js';
import { resetDb } from '../test/db.js';
import { generateKey } from './keys.js';
import type { FastifyInstance } from 'fastify';
import type { IngestPayload } from '@query-analyser/contract';

let app: FastifyInstance;
beforeAll(async () => { app = await buildApp({ logger: false }); });
beforeEach(async () => { await resetDb(app.prisma); });
afterAll(async () => { await app.close(); });

async function seedKey(opts: { suspended?: boolean; revoked?: boolean } = {}) {
  const org = await app.prisma.organization.create({ data: { name: 'A', slug: 'a', suspendedAt: opts.suspended ? new Date() : null } });
  const a = await app.prisma.app.create({ data: { orgId: org.id, name: 'web', env: 'prod' } });
  const k = generateKey();
  await app.prisma.ingestKey.create({ data: { appId: a.id, keyHash: k.hash, prefix: k.prefix, revokedAt: opts.revoked ? new Date() : null } });
  return { app: a, key: k.key };
}

const payload = (n = 1): IngestPayload => ({
  app: 'web', env: 'prod', host: 'h', sdkVersion: '0.1.0', bucket: '2026092014', thresholdMs: 100, dropped: 0,
  items: Array.from({ length: n }, (_, i) => ({
    signature: `S${i}`, hash: i.toString(16).padStart(16, '0'), model: 'M', operation: 'find',
    filterShape: [], sortKeys: [], stages: [], count: 1, totalMs: 120, maxMs: 120, lastMs: 120, lastTs: 1,
    hist: [0, 1, 0, 0, 0, 0, 0, 0], sample: null,
  })),
});

const post = (key: string | null, body: unknown, headers: Record<string, string> = {}) =>
  app.inject({
    method: 'POST', url: '/v1/ingest',
    headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}), ...headers },
    payload: typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body),
  });

describe('POST /v1/ingest', () => {
  it('accepts a valid batch and writes it', async () => {
    const { app: a, key } = await seedKey();
    const res = await post(key, payload(2));
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ accepted: 2 });
    expect(await app.prisma.querySignature.count({ where: { appId: a.id } })).toBe(2);
  });

  it('accepts a gzip-encoded body', async () => {
    const { key } = await seedKey();
    const res = await post(key, gzipSync(JSON.stringify(payload(3))), { 'content-encoding': 'gzip' });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ accepted: 3 });
  });

  it('stamps lastUsedAt on the key', async () => {
    const { key } = await seedKey();
    await post(key, payload());
    const row = await app.prisma.ingestKey.findFirstOrThrow();
    expect(row.lastUsedAt).not.toBeNull();
  });

  it('401s without a key, with a malformed key, and with an unknown key', async () => {
    expect((await post(null, payload())).statusCode).toBe(401);
    expect((await post('nope', payload())).statusCode).toBe(401);
    expect((await post('qa_live_' + 'f'.repeat(32), payload())).statusCode).toBe(401);
  });

  it('401s a revoked key', async () => {
    const { key } = await seedKey({ revoked: true });
    expect((await post(key, payload())).statusCode).toBe(401);
  });

  it('403s a suspended org', async () => {
    const { key } = await seedKey({ suspended: true });
    expect((await post(key, payload())).statusCode).toBe(403);
  });

  it('400s an invalid body with zod issues', async () => {
    const { key } = await seedKey();
    const bad = { ...payload(), bucket: 'nope' };
    const res = await post(key, bad);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'invalid payload', issues: expect.any(Array) });
  });

  it('400s a histogram of the wrong length', async () => {
    const { key } = await seedKey();
    const p = payload();
    p.items[0]!.hist = [1, 2, 3];
    expect((await post(key, p)).statusCode).toBe(400);
  });

  it('429s when the app is over its signature quota', async () => {
    const { app: a, key } = await seedKey();
    // Fill the quota directly.
    await app.prisma.querySignature.createMany({
      data: Array.from({ length: 5000 }, (_, i) => ({
        appId: a.id, hash: `q${i}`.padStart(16, '0'), signature: 's', model: 'M', operation: 'find',
        filterShape: [], sortKeys: [], stages: [],
      })),
    });
    const res = await post(key, payload());
    expect(res.statusCode).toBe(429);
    expect(res.json()).toMatchObject({ error: 'signature quota exceeded', limit: 5000 });
  });

  it('still accepts a batch of already-known signatures at quota', async () => {
    const { app: a, key } = await seedKey();
    await post(key, payload(1));
    await app.prisma.querySignature.createMany({
      data: Array.from({ length: 4999 }, (_, i) => ({
        appId: a.id, hash: `q${i}`.padStart(16, '0'), signature: 's', model: 'M', operation: 'find',
        filterShape: [], sortKeys: [], stages: [],
      })),
    });
    expect((await post(key, payload(1))).statusCode).toBe(202);
  });

  it('413s a body over the limit', async () => {
    const { key } = await seedKey();
    const huge = payload(1);
    huge.items[0]!.sample = { x: 'y'.repeat(3 * 1024 * 1024) };
    expect((await post(key, huge)).statusCode).toBe(413);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @query-analyser/api test -- routes`
Expected: FAIL — `app.prisma` undefined / route 404.

- [ ] **Step 3: Implement the plugin and route, register in app**

`apps/api/src/plugins/prisma.ts`:
```ts
import fp from 'fastify-plugin';
import type { FastifyInstance } from 'fastify';
import { createPrisma, type PrismaClient } from '../db.js';
import { KeyResolver } from '../ingest/keys.js';

export default fp(async function prismaPlugin(app: FastifyInstance) {
  const prisma = createPrisma(app.config.DATABASE_URL);
  app.decorate('prisma', prisma);
  app.decorate('keys', new KeyResolver(prisma));
  app.addHook('onClose', async () => { await prisma.$disconnect(); });
});

declare module 'fastify' {
  interface FastifyInstance {
    prisma: PrismaClient;
    keys: KeyResolver;
  }
}
```

Add `"fastify-plugin": "^5.0.1"` to `apps/api/package.json` dependencies.

`apps/api/src/ingest/routes.ts`:
```ts
import type { FastifyInstance } from 'fastify';
import { ingestPayloadSchema } from '@query-analyser/contract';
import { writeBatch } from './writer.js';

const SIGNATURE_QUOTA = 5000;
const MAX_BODY_BYTES = 2 * 1024 * 1024;

export async function ingestRoutes(app: FastifyInstance): Promise<void> {
  app.post('/v1/ingest', {
    bodyLimit: MAX_BODY_BYTES,
    config: { rateLimit: { max: 120, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const auth = req.headers.authorization ?? '';
    const key = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
    const resolved = key ? await app.keys.resolve(key) : null;
    if (!resolved) return reply.code(401).send({ error: 'invalid ingest key' });
    if (resolved.suspended) return reply.code(403).send({ error: 'organization suspended' });

    const parsed = ingestPayloadSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid payload', issues: parsed.error.issues.slice(0, 20) });
    }
    const payload = parsed.data;

    // Quota: only new hashes count toward it.
    const hashes = [...new Set(payload.items.map((i) => i.hash))];
    if (hashes.length > 0) {
      const known = await app.prisma.querySignature.count({ where: { appId: resolved.appId, hash: { in: hashes } } });
      const newCount = hashes.length - known;
      if (newCount > 0) {
        const existing = await app.prisma.querySignature.count({ where: { appId: resolved.appId } });
        if (existing + newCount > SIGNATURE_QUOTA) {
          return reply.code(429).send({ error: 'signature quota exceeded', limit: SIGNATURE_QUOTA });
        }
      }
    }

    const { signatures } = await writeBatch(app.prisma, resolved.appId, payload);

    // Fire-and-forget: never make the SDK wait on a bookkeeping write.
    void app.prisma.ingestKey.update({ where: { id: resolved.keyId }, data: { lastUsedAt: new Date() } })
      .catch((err: unknown) => req.log.warn({ err }, 'lastUsedAt update failed'));

    return reply.code(202).send({ accepted: signatures });
  });
}
```

Modify `apps/api/src/app.ts` — after `app.decorate('config', config)` add:
```ts
  await app.register(import('@fastify/compress'), {
    global: false,
    requestEncodings: ['gzip', 'deflate'],
    onUnsupportedRequestEncoding: (encoding) => ({ statusCode: 415, error: 'Unsupported Media Type', message: `unsupported content-encoding: ${encoding}` }),
  });
  await app.register(import('@fastify/rate-limit'), {
    global: false,
    keyGenerator: (req) => req.headers.authorization ?? req.ip,
  });
  await app.register(import('./plugins/prisma.js'));
  await app.register(ingestRoutes);
```
with `import { ingestRoutes } from './ingest/routes.js';` at the top.

`@fastify/compress` with `global: false` still decompresses request bodies for `requestEncodings` on every route (request decompression is an `onRequest`/`preParsing` hook, independent of response compression). If your installed version requires `inflateIfDeflated`/other flags, follow its README and note it.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @query-analyser/api test -- routes`
Expected: PASS (11 tests). If `413` returns as `400` because the body limit is applied after decompression, set `bodyLimit` on the route (as shown) AND confirm the JSON parser respects it; Fastify enforces `bodyLimit` on the raw (post-decompression) stream.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src apps/api/package.json pnpm-lock.yaml
git commit -m "feat(api): add authenticated, gzip-aware, rate-limited ingest route with quota"
```

---

### Task 6: End-to-end — the published SDK talking to this API

Proves the contract holds across the two independently-built halves. Uses the real published package, not the workspace one.

**Files:**
- Create: `apps/api/src/ingest/e2e.test.ts`
- Modify: `apps/api/package.json` devDependencies: `"@vivekumar08/query-analyser": "^0.1.0"`, `"mongoose": "^8.9.0"`, `"mongodb-memory-server": "^10.1.2"`
- Modify: `apps/api/vitest.config.ts` — `testTimeout: 90_000`

**Interfaces:**
- Consumes: everything from Tasks 1–5.
- Produces: nothing new; this is the gate the spec's delivery order calls "verified by pointing a real KISNA service at it".

- [ ] **Step 1: Write the test**

`apps/api/src/ingest/e2e.test.ts`:
```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { init, shutdown } from '@vivekumar08/query-analyser';
import { buildApp } from '../app.js';
import { resetDb } from '../test/db.js';
import { generateKey } from './keys.js';
import type { FastifyInstance } from 'fastify';

let app: FastifyInstance;
let mongod: MongoMemoryServer;
let baseUrl: string;

beforeAll(async () => {
  app = await buildApp({ logger: false });
  await resetDb(app.prisma);
  // Listen on a real port: the SDK uses fetch, not inject.
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  baseUrl = typeof addr === 'object' && addr ? `http://127.0.0.1:${addr.port}` : '';
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
});

afterAll(async () => {
  await shutdown();
  await mongoose.disconnect();
  await mongod.stop();
  await app.close();
});

describe('published SDK → this API', () => {
  it('a real mongoose query lands as a signature and a rollup', async () => {
    const org = await app.prisma.organization.create({ data: { name: 'Kisna', slug: 'kisna' } });
    const a = await app.prisma.app.create({ data: { orgId: org.id, name: 'kisna-web', env: 'test' } });
    const k = generateKey();
    await app.prisma.ingestKey.create({ data: { appId: a.id, keyHash: k.hash, prefix: k.prefix } });

    const Order = mongoose.model(`E2EOrder_${Date.now()}`, new mongoose.Schema({ status: String, total: Number }));
    const analyser = init({
      apiKey: k.key, app: 'kisna-web', env: 'test', thresholdMs: 0,
      endpoint: `${baseUrl}/v1/ingest`, mongoose,
    });

    await Order.find({ status: 'paid', total: { $gte: 10 } }).sort({ total: -1 }).exec();
    await Order.find({ status: 'void', total: { $gte: 99 } }).sort({ total: -1 }).exec();
    await analyser.flush();

    const sigs = await app.prisma.querySignature.findMany({ where: { appId: a.id } });
    expect(sigs).toHaveLength(1);
    expect(sigs[0]).toMatchObject({ operation: 'find', filterShape: [{ key: 'status', op: 'eq' }, { key: 'total', op: 'range' }] });
    expect(sigs[0]!.model).toMatch(/^E2EOrder_/);
    expect(JSON.stringify(sigs[0]!.redactedSample)).not.toContain('paid');

    const roll = await app.prisma.queryRollup.findFirstOrThrow({ where: { signatureId: sigs[0]!.id } });
    expect(roll.count).toBe(2);
    expect(roll.hist.reduce((x, y) => x + y, 0)).toBe(2);
  });

  it('a revoked key disables the SDK after one 401', async () => {
    await resetDb(app.prisma);
    await shutdown();
    const org = await app.prisma.organization.create({ data: { name: 'K2', slug: 'k2' } });
    const a = await app.prisma.app.create({ data: { orgId: org.id, name: 'x', env: 'test' } });
    const k = generateKey();
    await app.prisma.ingestKey.create({ data: { appId: a.id, keyHash: k.hash, prefix: k.prefix, revokedAt: new Date() } });

    const errors: string[] = [];
    const M = mongoose.model(`E2ERevoked_${Date.now()}`, new mongoose.Schema({ a: String }));
    const analyser = init({ apiKey: k.key, app: 'x', env: 'test', thresholdMs: 0, endpoint: `${baseUrl}/v1/ingest`, mongoose, onError: (e) => errors.push(e.message) });

    await M.find({ a: '1' }).exec();
    await analyser.flush();
    await M.find({ a: '2' }).exec();
    await analyser.flush();

    expect(errors.some((m) => /401|rejected/.test(m))).toBe(true);
    expect(await app.prisma.querySignature.count()).toBe(0);
  });
});
```

- [ ] **Step 2: Install and run**

Run: `pnpm install && pnpm --filter @query-analyser/api test -- e2e`
Expected: PASS (2 tests). First run downloads a mongod binary.

If the first test fails on `filterShape` ordering or `model`, the bug is in the API's handling (Tasks 4–5), not the SDK — the SDK's own integration suite asserts those exact shapes.

- [ ] **Step 3: Commit**

```bash
git add apps/api
git commit -m "test(api): end-to-end ingest from the published SDK"
```

---

### Task 7: Auth — signup, login, refresh rotation, logout, /me

**Files:**
- Create: `apps/api/src/auth/password.ts`, `apps/api/src/auth/tokens.ts`, `apps/api/src/auth/routes.ts`, `apps/api/src/plugins/auth.ts`
- Modify: `apps/api/src/app.ts`
- Test: `apps/api/src/auth/auth.test.ts`

**Interfaces:**
- Produces:
  - `hashPassword(pw): Promise<string>`, `verifyPassword(hash, pw): Promise<boolean>` (argon2id).
  - `issueRefreshToken(prisma, userId, familyId?): Promise<{ token: string; expiresAt: Date }>`; `rotateRefreshToken(prisma, token): Promise<{ userId: string; token: string; expiresAt: Date } | 'reused' | 'invalid'>`.
  - Routes: `POST /v1/auth/signup { email, password, name }` → 201 `{ accessToken, user }` + refresh cookie; `POST /v1/auth/login` → 200 same; `POST /v1/auth/refresh` (cookie) → 200 `{ accessToken }` + new cookie; `POST /v1/auth/logout` → 204, clears cookie, consumes token; `GET /v1/me` (bearer) → `{ id, email, name, isPlatformAdmin }`.
  - `app.authenticate` preHandler: verifies bearer JWT, sets `req.user = { id }`.
  - Access JWT: `{ sub: userId }`, 15 minutes. Refresh cookie name `qa_refresh`, `httpOnly`, `secure` in production, `sameSite: 'lax'`, `path: '/v1/auth'`, 30 days.

- [ ] **Step 1: Write the failing test**

`apps/api/src/auth/auth.test.ts`:
```ts
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { buildApp } from '../app.js';
import { resetDb } from '../test/db.js';
import type { FastifyInstance } from 'fastify';

let app: FastifyInstance;
beforeAll(async () => { app = await buildApp({ logger: false }); });
beforeEach(async () => { await resetDb(app.prisma); });
afterAll(async () => { await app.close(); });

const creds = { email: 'a@x.io', password: 'correct horse battery', name: 'A' };
const signup = (c = creds) => app.inject({ method: 'POST', url: '/v1/auth/signup', payload: c });
const login = (c = creds) => app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email: c.email, password: c.password } });
const cookieOf = (res: { cookies: { name: string; value: string }[] }) => res.cookies.find((c) => c.name === 'qa_refresh')?.value ?? '';

describe('signup', () => {
  it('creates a user, returns an access token and sets a refresh cookie', async () => {
    const res = await signup();
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ accessToken: expect.any(String), user: { email: 'a@x.io', name: 'A' } });
    const cookie = res.cookies.find((c) => c.name === 'qa_refresh');
    expect(cookie).toMatchObject({ httpOnly: true, path: '/v1/auth', sameSite: 'Lax' });
    const user = await app.prisma.user.findUniqueOrThrow({ where: { email: 'a@x.io' } });
    expect(user.passwordHash).toMatch(/^\$argon2id\$/);
  });

  it('rejects a duplicate email with 409', async () => {
    await signup();
    expect((await signup()).statusCode).toBe(409);
  });

  it('rejects a short password', async () => {
    expect((await signup({ ...creds, password: 'short' })).statusCode).toBe(400);
  });
});

describe('login', () => {
  it('returns 200 with a token for the right password and 401 for the wrong one', async () => {
    await signup();
    expect((await login()).statusCode).toBe(200);
    expect((await login({ ...creds, password: 'nope-nope-nope' })).statusCode).toBe(401);
  });

  it('401s an unknown email with the same shape as a wrong password', async () => {
    const res = await login({ ...creds, email: 'ghost@x.io' });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'invalid credentials' });
  });
});

describe('me', () => {
  it('returns the caller with a valid bearer token and 401 without', async () => {
    const token = (await signup()).json().accessToken as string;
    const ok = await app.inject({ method: 'GET', url: '/v1/me', headers: { authorization: `Bearer ${token}` } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ email: 'a@x.io', isPlatformAdmin: false });
    expect((await app.inject({ method: 'GET', url: '/v1/me' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/v1/me', headers: { authorization: 'Bearer junk' } })).statusCode).toBe(401);
  });
});

describe('refresh', () => {
  it('rotates: old cookie is consumed, new cookie works, old cookie is rejected', async () => {
    const first = cookieOf(await signup());
    const r1 = await app.inject({ method: 'POST', url: '/v1/auth/refresh', cookies: { qa_refresh: first } });
    expect(r1.statusCode).toBe(200);
    expect(r1.json()).toMatchObject({ accessToken: expect.any(String) });
    const second = cookieOf(r1);
    expect(second).not.toBe(first);

    const again = await app.inject({ method: 'POST', url: '/v1/auth/refresh', cookies: { qa_refresh: first } });
    expect(again.statusCode).toBe(401);

    const r2 = await app.inject({ method: 'POST', url: '/v1/auth/refresh', cookies: { qa_refresh: second } });
    expect(r2.statusCode).toBe(401);   // reuse of `first` revoked the whole family
  });

  it('a stolen token replayed after rotation revokes the family', async () => {
    const t0 = cookieOf(await signup());
    const t1 = cookieOf(await app.inject({ method: 'POST', url: '/v1/auth/refresh', cookies: { qa_refresh: t0 } }));
    expect((await app.inject({ method: 'POST', url: '/v1/auth/refresh', cookies: { qa_refresh: t0 } })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/v1/auth/refresh', cookies: { qa_refresh: t1 } })).statusCode).toBe(401);
    const rows = await app.prisma.refreshToken.findMany();
    expect(rows.every((r) => r.consumedAt !== null)).toBe(true);
  });

  it('401s with no cookie', async () => {
    expect((await app.inject({ method: 'POST', url: '/v1/auth/refresh' })).statusCode).toBe(401);
  });
});

describe('logout', () => {
  it('consumes the refresh token and clears the cookie', async () => {
    const t = cookieOf(await signup());
    const res = await app.inject({ method: 'POST', url: '/v1/auth/logout', cookies: { qa_refresh: t } });
    expect(res.statusCode).toBe(204);
    expect(res.cookies.find((c) => c.name === 'qa_refresh')?.value).toBe('');
    expect((await app.inject({ method: 'POST', url: '/v1/auth/refresh', cookies: { qa_refresh: t } })).statusCode).toBe(401);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @query-analyser/api test -- auth`
Expected: FAIL — routes 404.

- [ ] **Step 3: Implement**

`apps/api/src/auth/password.ts`:
```ts
import argon2 from 'argon2';

export function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 });
}

export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  try { return await argon2.verify(hash, password); } catch { return false; }
}
```
(These are the OWASP-recommended argon2id parameters for interactive logins.)

`apps/api/src/auth/tokens.ts`:
```ts
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { PrismaClient } from '../db.js';

export const REFRESH_TTL_MS = 30 * 24 * 3600 * 1000;

const hashToken = (t: string) => createHash('sha256').update(t).digest('hex');

export async function issueRefreshToken(prisma: PrismaClient, userId: string, familyId = randomUUID()) {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + REFRESH_TTL_MS);
  await prisma.refreshToken.create({ data: { userId, familyId, tokenHash: hashToken(token), expiresAt } });
  return { token, expiresAt, familyId };
}

export type RotateResult = { userId: string; token: string; expiresAt: Date } | 'reused' | 'invalid';

/**
 * Consume `token` and issue its successor in the same family.
 * A token that was already consumed is a replay: revoke the entire family.
 */
export async function rotateRefreshToken(prisma: PrismaClient, token: string): Promise<RotateResult> {
  const row = await prisma.refreshToken.findUnique({ where: { tokenHash: hashToken(token) } });
  if (!row || row.expiresAt < new Date()) return 'invalid';

  if (row.consumedAt) {
    await prisma.refreshToken.updateMany({ where: { familyId: row.familyId, consumedAt: null }, data: { consumedAt: new Date() } });
    return 'reused';
  }

  // Atomic consume: only one concurrent caller wins.
  const consumed = await prisma.refreshToken.updateMany({ where: { id: row.id, consumedAt: null }, data: { consumedAt: new Date() } });
  if (consumed.count === 0) return 'reused';

  const next = await issueRefreshToken(prisma, row.userId, row.familyId);
  return { userId: row.userId, token: next.token, expiresAt: next.expiresAt };
}

export async function consumeRefreshToken(prisma: PrismaClient, token: string): Promise<void> {
  await prisma.refreshToken.updateMany({ where: { tokenHash: hashToken(token), consumedAt: null }, data: { consumedAt: new Date() } });
}
```

`apps/api/src/plugins/auth.ts`:
```ts
import fp from 'fastify-plugin';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

export default fp(async function authPlugin(app: FastifyInstance) {
  await app.register(import('@fastify/cookie'), { secret: app.config.COOKIE_SECRET });
  await app.register(import('@fastify/jwt'), { secret: app.config.JWT_SECRET, sign: { expiresIn: '15m' } });

  app.decorate('authenticate', async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      const payload = await req.jwtVerify<{ sub: string }>();
      req.user = { id: payload.sub };
    } catch {
      await reply.code(401).send({ error: 'unauthorized' });
    }
  });
});

declare module 'fastify' {
  interface FastifyInstance {
    authenticate: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
  interface FastifyRequest {
    user: { id: string };
  }
}
declare module '@fastify/jwt' {
  interface FastifyJWT { payload: { sub: string }; user: { id: string } }
}
```

`apps/api/src/auth/routes.ts`:
```ts
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { hashPassword, verifyPassword } from './password.js';
import { issueRefreshToken, rotateRefreshToken, consumeRefreshToken, REFRESH_TTL_MS } from './tokens.js';

const COOKIE = 'qa_refresh';

const signupSchema = z.object({ email: z.string().email().max(200), password: z.string().min(12).max(200), name: z.string().min(1).max(100) });
const loginSchema = z.object({ email: z.string().email(), password: z.string() });

export async function authRoutes(app: FastifyInstance): Promise<void> {
  const setRefresh = (reply: FastifyReply, token: string) =>
    reply.setCookie(COOKIE, token, {
      httpOnly: true, sameSite: 'lax', path: '/v1/auth', secure: app.config.NODE_ENV === 'production',
      maxAge: Math.floor(REFRESH_TTL_MS / 1000),
    });

  const issue = async (reply: FastifyReply, userId: string) => {
    const accessToken = await reply.jwtSign({ sub: userId });
    const { token } = await issueRefreshToken(app.prisma, userId);
    setRefresh(reply, token);
    return accessToken;
  };

  app.post('/v1/auth/signup', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    const parsed = signupSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid body', issues: parsed.error.issues });
    const { email, password, name } = parsed.data;

    const exists = await app.prisma.user.findUnique({ where: { email: email.toLowerCase() } });
    if (exists) return reply.code(409).send({ error: 'email already registered' });

    const user = await app.prisma.user.create({
      data: { email: email.toLowerCase(), name, passwordHash: await hashPassword(password) },
      select: { id: true, email: true, name: true, isPlatformAdmin: true },
    });
    const accessToken = await issue(reply, user.id);
    return reply.code(201).send({ accessToken, user });
  });

  app.post('/v1/auth/login', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req, reply) => {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid body' });
    const user = await app.prisma.user.findUnique({ where: { email: parsed.data.email.toLowerCase() } });
    // Constant-shape response whether the email exists or not.
    const ok = user ? await verifyPassword(user.passwordHash, parsed.data.password) : false;
    if (!user || !ok) return reply.code(401).send({ error: 'invalid credentials' });
    const accessToken = await issue(reply, user.id);
    return reply.send({ accessToken, user: { id: user.id, email: user.email, name: user.name, isPlatformAdmin: user.isPlatformAdmin } });
  });

  app.post('/v1/auth/refresh', async (req, reply) => {
    const token = req.cookies[COOKIE];
    if (!token) return reply.code(401).send({ error: 'no refresh token' });
    const result = await rotateRefreshToken(app.prisma, token);
    if (result === 'invalid' || result === 'reused') {
      reply.clearCookie(COOKIE, { path: '/v1/auth' });
      return reply.code(401).send({ error: 'invalid refresh token' });
    }
    setRefresh(reply, result.token);
    const accessToken = await reply.jwtSign({ sub: result.userId });
    return reply.send({ accessToken });
  });

  app.post('/v1/auth/logout', async (req, reply) => {
    const token = req.cookies[COOKIE];
    if (token) await consumeRefreshToken(app.prisma, token);
    reply.clearCookie(COOKIE, { path: '/v1/auth' });
    return reply.code(204).send();
  });

  app.get('/v1/me', { preHandler: [app.authenticate] }, async (req, reply) => {
    const user = await app.prisma.user.findUnique({
      where: { id: req.user.id }, select: { id: true, email: true, name: true, isPlatformAdmin: true },
    });
    if (!user) return reply.code(401).send({ error: 'unauthorized' });
    return user;
  });
}
```

In `apps/api/src/app.ts` register `./plugins/auth.js` after the prisma plugin, then `authRoutes`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @query-analyser/api test -- auth`
Expected: PASS (10 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src
git commit -m "feat(api): add argon2id auth with JWT access tokens and rotating refresh tokens"
```

---

### Task 8: Organizations, memberships and the RBAC guard

**Files:**
- Create: `apps/api/src/orgs/rbac.ts`, `apps/api/src/orgs/routes.ts`
- Modify: `apps/api/src/app.ts`
- Test: `apps/api/src/orgs/rbac.test.ts`, `apps/api/src/orgs/routes.test.ts`

**Interfaces:**
- Produces:
  - `roleAtLeast(actual: Role, min: Role): boolean` with order `OWNER > ADMIN > MEMBER > VIEWER`.
  - `requireRole(min: Role)` — a preHandler factory. Reads `req.params.org` (an org **id**), loads the caller's membership, 404s if none (never reveal existence), 403s if below `min`, and sets `req.membership = { orgId, role }`.
  - Routes: `GET /v1/orgs` (caller's orgs with role); `POST /v1/orgs { name }` → 201, creates org with slug from name (+ random suffix on collision) and an OWNER membership; `GET /v1/orgs/:org` (VIEWER+); `GET /v1/orgs/:org/members` (ADMIN+); `PATCH /v1/orgs/:org/members/:id { role }` (OWNER; cannot demote the last OWNER); `DELETE /v1/orgs/:org/members/:id` (OWNER; cannot remove the last OWNER).

- [ ] **Step 1: Write the failing tests**

`apps/api/src/orgs/rbac.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { roleAtLeast } from './rbac.js';

describe('roleAtLeast', () => {
  it('orders OWNER > ADMIN > MEMBER > VIEWER', () => {
    expect(roleAtLeast('OWNER', 'VIEWER')).toBe(true);
    expect(roleAtLeast('ADMIN', 'MEMBER')).toBe(true);
    expect(roleAtLeast('MEMBER', 'ADMIN')).toBe(false);
    expect(roleAtLeast('VIEWER', 'VIEWER')).toBe(true);
    expect(roleAtLeast('VIEWER', 'MEMBER')).toBe(false);
  });
});
```

`apps/api/src/orgs/routes.test.ts`:
```ts
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { buildApp } from '../app.js';
import { resetDb } from '../test/db.js';
import type { FastifyInstance } from 'fastify';

let app: FastifyInstance;
beforeAll(async () => { app = await buildApp({ logger: false }); });
beforeEach(async () => { await resetDb(app.prisma); });
afterAll(async () => { await app.close(); });

async function user(email: string) {
  const res = await app.inject({ method: 'POST', url: '/v1/auth/signup', payload: { email, password: 'correct horse battery', name: email } });
  return { token: res.json().accessToken as string, id: res.json().user.id as string };
}
const as = (token: string) => ({ authorization: `Bearer ${token}` });

describe('orgs', () => {
  it('creates an org and makes the creator OWNER', async () => {
    const u = await user('o@x.io');
    const res = await app.inject({ method: 'POST', url: '/v1/orgs', headers: as(u.token), payload: { name: 'Acme Inc' } });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ name: 'Acme Inc', slug: 'acme-inc', role: 'OWNER' });
    const list = await app.inject({ method: 'GET', url: '/v1/orgs', headers: as(u.token) });
    expect(list.json()).toHaveLength(1);
  });

  it('suffixes a colliding slug', async () => {
    const u = await user('o@x.io');
    await app.inject({ method: 'POST', url: '/v1/orgs', headers: as(u.token), payload: { name: 'Acme' } });
    const res = await app.inject({ method: 'POST', url: '/v1/orgs', headers: as(u.token), payload: { name: 'Acme' } });
    expect(res.statusCode).toBe(201);
    expect(res.json().slug).toMatch(/^acme-[a-z0-9]{4}$/);
  });

  it('404s an org the caller is not a member of — never 403', async () => {
    const a = await user('a@x.io'); const b = await user('b@x.io');
    const org = (await app.inject({ method: 'POST', url: '/v1/orgs', headers: as(a.token), payload: { name: 'A' } })).json();
    const res = await app.inject({ method: 'GET', url: `/v1/orgs/${org.id}`, headers: as(b.token) });
    expect(res.statusCode).toBe(404);
  });

  it('403s a member below the required role', async () => {
    const a = await user('a@x.io'); const b = await user('b@x.io');
    const org = (await app.inject({ method: 'POST', url: '/v1/orgs', headers: as(a.token), payload: { name: 'A' } })).json();
    await app.prisma.membership.create({ data: { userId: b.id, orgId: org.id, role: 'VIEWER' } });
    expect((await app.inject({ method: 'GET', url: `/v1/orgs/${org.id}`, headers: as(b.token) })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: `/v1/orgs/${org.id}/members`, headers: as(b.token) })).statusCode).toBe(403);
  });

  it('OWNER can change roles but cannot demote the last OWNER', async () => {
    const a = await user('a@x.io'); const b = await user('b@x.io');
    const org = (await app.inject({ method: 'POST', url: '/v1/orgs', headers: as(a.token), payload: { name: 'A' } })).json();
    const mb = await app.prisma.membership.create({ data: { userId: b.id, orgId: org.id, role: 'MEMBER' } });
    const ma = await app.prisma.membership.findFirstOrThrow({ where: { userId: a.id, orgId: org.id } });

    expect((await app.inject({ method: 'PATCH', url: `/v1/orgs/${org.id}/members/${mb.id}`, headers: as(a.token), payload: { role: 'ADMIN' } })).statusCode).toBe(200);
    const self = await app.inject({ method: 'PATCH', url: `/v1/orgs/${org.id}/members/${ma.id}`, headers: as(a.token), payload: { role: 'ADMIN' } });
    expect(self.statusCode).toBe(409);
    expect(self.json()).toMatchObject({ error: 'organization must keep at least one owner' });
  });

  it('OWNER can remove a member but not the last OWNER', async () => {
    const a = await user('a@x.io'); const b = await user('b@x.io');
    const org = (await app.inject({ method: 'POST', url: '/v1/orgs', headers: as(a.token), payload: { name: 'A' } })).json();
    const mb = await app.prisma.membership.create({ data: { userId: b.id, orgId: org.id, role: 'MEMBER' } });
    const ma = await app.prisma.membership.findFirstOrThrow({ where: { userId: a.id, orgId: org.id } });
    expect((await app.inject({ method: 'DELETE', url: `/v1/orgs/${org.id}/members/${mb.id}`, headers: as(a.token) })).statusCode).toBe(204);
    expect((await app.inject({ method: 'DELETE', url: `/v1/orgs/${org.id}/members/${ma.id}`, headers: as(a.token) })).statusCode).toBe(409);
  });

  it('ADMIN cannot change roles', async () => {
    const a = await user('a@x.io'); const b = await user('b@x.io');
    const org = (await app.inject({ method: 'POST', url: '/v1/orgs', headers: as(a.token), payload: { name: 'A' } })).json();
    await app.prisma.membership.create({ data: { userId: b.id, orgId: org.id, role: 'ADMIN' } });
    const ma = await app.prisma.membership.findFirstOrThrow({ where: { userId: a.id, orgId: org.id } });
    expect((await app.inject({ method: 'PATCH', url: `/v1/orgs/${org.id}/members/${ma.id}`, headers: as(b.token), payload: { role: 'VIEWER' } })).statusCode).toBe(403);
  });

  it('a membership id from ANOTHER org cannot be modified through this org', async () => {
    const a = await user('a@x.io'); const b = await user('b@x.io');
    const orgA = (await app.inject({ method: 'POST', url: '/v1/orgs', headers: as(a.token), payload: { name: 'A' } })).json();
    const orgB = (await app.inject({ method: 'POST', url: '/v1/orgs', headers: as(b.token), payload: { name: 'B' } })).json();
    const mb = await app.prisma.membership.findFirstOrThrow({ where: { userId: b.id, orgId: orgB.id } });
    const res = await app.inject({ method: 'PATCH', url: `/v1/orgs/${orgA.id}/members/${mb.id}`, headers: as(a.token), payload: { role: 'VIEWER' } });
    expect(res.statusCode).toBe(404);
    expect((await app.prisma.membership.findUniqueOrThrow({ where: { id: mb.id } })).role).toBe('OWNER');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @query-analyser/api test -- orgs`
Expected: FAIL.

- [ ] **Step 3: Implement**

`apps/api/src/orgs/rbac.ts`:
```ts
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Role } from '../generated/prisma/client.js';

const RANK: Record<Role, number> = { OWNER: 3, ADMIN: 2, MEMBER: 1, VIEWER: 0 };

export function roleAtLeast(actual: Role, min: Role): boolean {
  return RANK[actual] >= RANK[min];
}

/**
 * preHandler: resolve the caller's membership in `:org` and enforce a minimum role.
 * Non-members get 404, not 403 — org ids must not be enumerable.
 */
export function requireRole(min: Role) {
  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const orgId = (req.params as { org?: string }).org;
    if (!orgId) { await reply.code(404).send({ error: 'Not Found' }); return; }
    const m = await req.server.prisma.membership.findUnique({
      where: { userId_orgId: { userId: req.user.id, orgId } },
      select: { orgId: true, role: true, org: { select: { suspendedAt: true } } },
    });
    if (!m) { await reply.code(404).send({ error: 'Not Found' }); return; }
    if (m.org.suspendedAt) { await reply.code(403).send({ error: 'organization suspended' }); return; }
    if (!roleAtLeast(m.role, min)) { await reply.code(403).send({ error: 'insufficient role' }); return; }
    req.membership = { orgId: m.orgId, role: m.role };
  };
}

declare module 'fastify' {
  interface FastifyRequest { membership: { orgId: string; role: Role } }
}
```

`apps/api/src/orgs/routes.ts`:
```ts
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { randomBytes } from 'node:crypto';
import { requireRole } from './rbac.js';

const ROLES = ['OWNER', 'ADMIN', 'MEMBER', 'VIEWER'] as const;
const createSchema = z.object({ name: z.string().min(1).max(100) });
const roleSchema = z.object({ role: z.enum(ROLES) });

export function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50) || 'org';
}

export async function orgRoutes(app: FastifyInstance): Promise<void> {
  app.get('/v1/orgs', { preHandler: [app.authenticate] }, async (req) => {
    const rows = await app.prisma.membership.findMany({
      where: { userId: req.user.id },
      select: { role: true, org: { select: { id: true, name: true, slug: true, plan: true, createdAt: true } } },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((r) => ({ ...r.org, role: r.role }));
  });

  app.post('/v1/orgs', { preHandler: [app.authenticate] }, async (req, reply) => {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid body' });
    const base = slugify(parsed.data.name);
    const taken = await app.prisma.organization.findUnique({ where: { slug: base } });
    const slug = taken ? `${base}-${randomBytes(2).toString('hex')}` : base;
    const org = await app.prisma.organization.create({
      data: { name: parsed.data.name, slug, memberships: { create: { userId: req.user.id, role: 'OWNER' } } },
      select: { id: true, name: true, slug: true, plan: true, createdAt: true },
    });
    return reply.code(201).send({ ...org, role: 'OWNER' });
  });

  app.get('/v1/orgs/:org', { preHandler: [app.authenticate, requireRole('VIEWER')] }, async (req) => {
    const org = await app.prisma.organization.findUniqueOrThrow({
      where: { id: req.membership.orgId }, select: { id: true, name: true, slug: true, plan: true, createdAt: true },
    });
    return { ...org, role: req.membership.role };
  });

  app.get('/v1/orgs/:org/members', { preHandler: [app.authenticate, requireRole('ADMIN')] }, async (req) => {
    return app.prisma.membership.findMany({
      where: { orgId: req.membership.orgId },
      select: { id: true, role: true, createdAt: true, user: { select: { id: true, email: true, name: true } } },
      orderBy: { createdAt: 'asc' },
    });
  });

  const ownerCount = (orgId: string) => app.prisma.membership.count({ where: { orgId, role: 'OWNER' } });

  app.patch('/v1/orgs/:org/members/:id', { preHandler: [app.authenticate, requireRole('OWNER')] }, async (req, reply) => {
    const parsed = roleSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid body' });
    const { id } = req.params as { id: string };
    const target = await app.prisma.membership.findFirst({ where: { id, orgId: req.membership.orgId } });
    if (!target) return reply.code(404).send({ error: 'Not Found' });
    if (target.role === 'OWNER' && parsed.data.role !== 'OWNER' && (await ownerCount(target.orgId)) <= 1) {
      return reply.code(409).send({ error: 'organization must keep at least one owner' });
    }
    return app.prisma.membership.update({ where: { id }, data: { role: parsed.data.role }, select: { id: true, role: true } });
  });

  app.delete('/v1/orgs/:org/members/:id', { preHandler: [app.authenticate, requireRole('OWNER')] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const target = await app.prisma.membership.findFirst({ where: { id, orgId: req.membership.orgId } });
    if (!target) return reply.code(404).send({ error: 'Not Found' });
    if (target.role === 'OWNER' && (await ownerCount(target.orgId)) <= 1) {
      return reply.code(409).send({ error: 'organization must keep at least one owner' });
    }
    await app.prisma.membership.delete({ where: { id } });
    return reply.code(204).send();
  });
}
```

Register `orgRoutes` in `app.ts`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @query-analyser/api test -- orgs`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src
git commit -m "feat(api): add organizations, memberships and the requireRole guard"
```

---

### Task 9: Apps and ingest keys

**Files:**
- Create: `apps/api/src/apps/routes.ts`
- Modify: `apps/api/src/app.ts`
- Test: `apps/api/src/apps/routes.test.ts`

**Interfaces:**
- Produces: `GET /v1/orgs/:org/apps` (VIEWER+); `POST /v1/orgs/:org/apps { name, env }` (MEMBER+) → 201, 409 on duplicate `(name, env)`; `GET /v1/apps/:id` (VIEWER+ in the app's org — resolved via `requireAppRole`) with `ingest: { lastSeenAt, keyCount }`; `GET /v1/apps/:id/keys` (ADMIN+) prefixes only; `POST /v1/apps/:id/keys` (ADMIN+) → 201 `{ id, key, prefix }` — the only time `key` is returned; `DELETE /v1/apps/:id/keys/:keyId` (ADMIN+) → 204, sets `revokedAt` and calls `app.keys.invalidate(hash)`.
- `requireAppRole(min)` — like `requireRole` but resolves the org through `App.orgId` from `:id`. Non-member → 404.

- [ ] **Step 1: Write the failing test**

`apps/api/src/apps/routes.test.ts`:
```ts
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { buildApp } from '../app.js';
import { resetDb } from '../test/db.js';
import { hashKey } from '../ingest/keys.js';
import type { FastifyInstance } from 'fastify';

let app: FastifyInstance;
beforeAll(async () => { app = await buildApp({ logger: false }); });
beforeEach(async () => { await resetDb(app.prisma); });
afterAll(async () => { await app.close(); });

async function owner() {
  const s = await app.inject({ method: 'POST', url: '/v1/auth/signup', payload: { email: 'o@x.io', password: 'correct horse battery', name: 'O' } });
  const token = s.json().accessToken as string;
  const org = (await app.inject({ method: 'POST', url: '/v1/orgs', headers: { authorization: `Bearer ${token}` }, payload: { name: 'Acme' } })).json();
  return { token, orgId: org.id as string, h: { authorization: `Bearer ${token}` } };
}

describe('apps', () => {
  it('creates and lists apps in an org', async () => {
    const o = await owner();
    const c = await app.inject({ method: 'POST', url: `/v1/orgs/${o.orgId}/apps`, headers: o.h, payload: { name: 'web', env: 'production' } });
    expect(c.statusCode).toBe(201);
    const l = await app.inject({ method: 'GET', url: `/v1/orgs/${o.orgId}/apps`, headers: o.h });
    expect(l.json()).toEqual([expect.objectContaining({ name: 'web', env: 'production' })]);
  });

  it('409s a duplicate (name, env)', async () => {
    const o = await owner();
    await app.inject({ method: 'POST', url: `/v1/orgs/${o.orgId}/apps`, headers: o.h, payload: { name: 'web', env: 'production' } });
    expect((await app.inject({ method: 'POST', url: `/v1/orgs/${o.orgId}/apps`, headers: o.h, payload: { name: 'web', env: 'production' } })).statusCode).toBe(409);
  });

  it('GET /v1/apps/:id reports ingest health', async () => {
    const o = await owner();
    const a = (await app.inject({ method: 'POST', url: `/v1/orgs/${o.orgId}/apps`, headers: o.h, payload: { name: 'web', env: 'production' } })).json();
    const g = await app.inject({ method: 'GET', url: `/v1/apps/${a.id}`, headers: o.h });
    expect(g.statusCode).toBe(200);
    expect(g.json()).toMatchObject({ id: a.id, ingest: { lastSeenAt: null, keyCount: 0 } });
  });

  it('404s an app in an org the caller is not part of', async () => {
    const o = await owner();
    const a = (await app.inject({ method: 'POST', url: `/v1/orgs/${o.orgId}/apps`, headers: o.h, payload: { name: 'web', env: 'production' } })).json();
    const s = await app.inject({ method: 'POST', url: '/v1/auth/signup', payload: { email: 'x@x.io', password: 'correct horse battery', name: 'X' } });
    const res = await app.inject({ method: 'GET', url: `/v1/apps/${a.id}`, headers: { authorization: `Bearer ${s.json().accessToken}` } });
    expect(res.statusCode).toBe(404);
  });
});

describe('keys', () => {
  it('creates a key, returns it exactly once, stores only its hash and prefix', async () => {
    const o = await owner();
    const a = (await app.inject({ method: 'POST', url: `/v1/orgs/${o.orgId}/apps`, headers: o.h, payload: { name: 'web', env: 'production' } })).json();
    const c = await app.inject({ method: 'POST', url: `/v1/apps/${a.id}/keys`, headers: o.h });
    expect(c.statusCode).toBe(201);
    const { key, prefix, id } = c.json();
    expect(key).toMatch(/^qa_live_[0-9a-f]{32}$/);
    expect(prefix).toBe(key.slice(0, 12));

    const row = await app.prisma.ingestKey.findUniqueOrThrow({ where: { id } });
    expect(row.keyHash).toBe(hashKey(key));
    expect(JSON.stringify(row)).not.toContain(key);

    const l = await app.inject({ method: 'GET', url: `/v1/apps/${a.id}/keys`, headers: o.h });
    expect(l.json()).toEqual([expect.objectContaining({ id, prefix, revokedAt: null })]);
    expect(JSON.stringify(l.json())).not.toContain(key);
  });

  it('revokes a key and the ingest route rejects it immediately', async () => {
    const o = await owner();
    const a = (await app.inject({ method: 'POST', url: `/v1/orgs/${o.orgId}/apps`, headers: o.h, payload: { name: 'web', env: 'production' } })).json();
    const { key, id } = (await app.inject({ method: 'POST', url: `/v1/apps/${a.id}/keys`, headers: o.h })).json();
    const body = { app: 'web', env: 'production', host: 'h', sdkVersion: '0.1.0', bucket: '2026092014', thresholdMs: 100, dropped: 0, items: [] };
    expect((await app.inject({ method: 'POST', url: '/v1/ingest', headers: { authorization: `Bearer ${key}` }, payload: body })).statusCode).toBe(202);
    expect((await app.inject({ method: 'DELETE', url: `/v1/apps/${a.id}/keys/${id}`, headers: o.h })).statusCode).toBe(204);
    expect((await app.inject({ method: 'POST', url: '/v1/ingest', headers: { authorization: `Bearer ${key}` }, payload: body })).statusCode).toBe(401);
  });

  it('MEMBER cannot manage keys', async () => {
    const o = await owner();
    const a = (await app.inject({ method: 'POST', url: `/v1/orgs/${o.orgId}/apps`, headers: o.h, payload: { name: 'web', env: 'production' } })).json();
    const s = await app.inject({ method: 'POST', url: '/v1/auth/signup', payload: { email: 'm@x.io', password: 'correct horse battery', name: 'M' } });
    await app.prisma.membership.create({ data: { userId: s.json().user.id, orgId: o.orgId, role: 'MEMBER' } });
    const h = { authorization: `Bearer ${s.json().accessToken}` };
    expect((await app.inject({ method: 'POST', url: `/v1/apps/${a.id}/keys`, headers: h })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: `/v1/apps/${a.id}/keys`, headers: h })).statusCode).toBe(403);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @query-analyser/api test -- apps`
Expected: FAIL.

- [ ] **Step 3: Implement**

Add to `apps/api/src/orgs/rbac.ts`:
```ts
/** Like requireRole, but the org is found through the app in `:id`. */
export function requireAppRole(min: Role) {
  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const appId = (req.params as { id?: string }).id;
    if (!appId) { await reply.code(404).send({ error: 'Not Found' }); return; }
    const m = await req.server.prisma.membership.findFirst({
      where: { userId: req.user.id, org: { apps: { some: { id: appId } } } },
      select: { orgId: true, role: true, org: { select: { suspendedAt: true } } },
    });
    if (!m) { await reply.code(404).send({ error: 'Not Found' }); return; }
    if (m.org.suspendedAt) { await reply.code(403).send({ error: 'organization suspended' }); return; }
    if (!roleAtLeast(m.role, min)) { await reply.code(403).send({ error: 'insufficient role' }); return; }
    req.membership = { orgId: m.orgId, role: m.role };
    req.appId = appId;
  };
}
```
and extend the `FastifyRequest` augmentation with `appId: string`.

`apps/api/src/apps/routes.ts`:
```ts
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireRole, requireAppRole } from '../orgs/rbac.js';
import { generateKey } from '../ingest/keys.js';

const createSchema = z.object({ name: z.string().min(1).max(100), env: z.string().min(1).max(40) });
const appSelect = { id: true, name: true, env: true, createdAt: true } as const;

export async function appRoutes(app: FastifyInstance): Promise<void> {
  app.get('/v1/orgs/:org/apps', { preHandler: [app.authenticate, requireRole('VIEWER')] }, async (req) =>
    app.prisma.app.findMany({ where: { orgId: req.membership.orgId }, select: appSelect, orderBy: { createdAt: 'asc' } }));

  app.post('/v1/orgs/:org/apps', { preHandler: [app.authenticate, requireRole('MEMBER')] }, async (req, reply) => {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid body' });
    const exists = await app.prisma.app.findUnique({ where: { orgId_name_env: { orgId: req.membership.orgId, ...parsed.data } } });
    if (exists) return reply.code(409).send({ error: 'app already exists for this env' });
    const created = await app.prisma.app.create({ data: { orgId: req.membership.orgId, ...parsed.data }, select: appSelect });
    return reply.code(201).send(created);
  });

  app.get('/v1/apps/:id', { preHandler: [app.authenticate, requireAppRole('VIEWER')] }, async (req) => {
    const a = await app.prisma.app.findUniqueOrThrow({ where: { id: req.appId }, select: { ...appSelect, orgId: true } });
    const [keyCount, last] = await Promise.all([
      app.prisma.ingestKey.count({ where: { appId: req.appId, revokedAt: null } }),
      app.prisma.ingestKey.aggregate({ where: { appId: req.appId }, _max: { lastUsedAt: true } }),
    ]);
    return { ...a, ingest: { lastSeenAt: last._max.lastUsedAt, keyCount } };
  });

  app.get('/v1/apps/:id/keys', { preHandler: [app.authenticate, requireAppRole('ADMIN')] }, async (req) =>
    app.prisma.ingestKey.findMany({
      where: { appId: req.appId }, select: { id: true, prefix: true, lastUsedAt: true, revokedAt: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
    }));

  app.post('/v1/apps/:id/keys', { preHandler: [app.authenticate, requireAppRole('ADMIN')] }, async (req, reply) => {
    const k = generateKey();
    const row = await app.prisma.ingestKey.create({ data: { appId: req.appId, keyHash: k.hash, prefix: k.prefix }, select: { id: true, prefix: true, createdAt: true } });
    return reply.code(201).send({ ...row, key: k.key });
  });

  app.delete('/v1/apps/:id/keys/:keyId', { preHandler: [app.authenticate, requireAppRole('ADMIN')] }, async (req, reply) => {
    const { keyId } = req.params as { keyId: string };
    const row = await app.prisma.ingestKey.findFirst({ where: { id: keyId, appId: req.appId } });
    if (!row) return reply.code(404).send({ error: 'Not Found' });
    await app.prisma.ingestKey.update({ where: { id: keyId }, data: { revokedAt: new Date() } });
    app.keys.invalidate(row.keyHash);
    return reply.code(204).send();
  });
}
```

Register `appRoutes` in `app.ts`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @query-analyser/api test -- apps`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src
git commit -m "feat(api): add apps and ingest key management with immediate revocation"
```

---

### Task 10: Invites

**Files:**
- Create: `apps/api/src/orgs/invites.ts`
- Modify: `apps/api/src/app.ts`
- Test: `apps/api/src/orgs/invites.test.ts`

**Interfaces:**
- Produces: `POST /v1/orgs/:org/invites { email, role }` (ADMIN+; ADMIN may not invite OWNER) → 201 `{ id, email, role, expiresAt, token }` — `token` is returned once for the caller to deliver (no email in v1); `GET /v1/orgs/:org/invites` (ADMIN+) pending only, no tokens; `POST /v1/invites/:token/accept` (authenticated) → 200 `{ orgId, role }`; 404 unknown, 410 expired/used, 409 already a member, 403 if the caller's email does not match the invite.

- [ ] **Step 1: Write the failing test**

`apps/api/src/orgs/invites.test.ts`:
```ts
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { buildApp } from '../app.js';
import { resetDb } from '../test/db.js';
import type { FastifyInstance } from 'fastify';

let app: FastifyInstance;
beforeAll(async () => { app = await buildApp({ logger: false }); });
beforeEach(async () => { await resetDb(app.prisma); });
afterAll(async () => { await app.close(); });

async function user(email: string) {
  const s = await app.inject({ method: 'POST', url: '/v1/auth/signup', payload: { email, password: 'correct horse battery', name: email } });
  return { id: s.json().user.id as string, h: { authorization: `Bearer ${s.json().accessToken}` } };
}

describe('invites', () => {
  it('ADMIN+ creates an invite; the invitee accepts and becomes a member', async () => {
    const o = await user('o@x.io');
    const org = (await app.inject({ method: 'POST', url: '/v1/orgs', headers: o.h, payload: { name: 'A' } })).json();
    const inv = await app.inject({ method: 'POST', url: `/v1/orgs/${org.id}/invites`, headers: o.h, payload: { email: 'n@x.io', role: 'MEMBER' } });
    expect(inv.statusCode).toBe(201);
    const { token } = inv.json();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const list = await app.inject({ method: 'GET', url: `/v1/orgs/${org.id}/invites`, headers: o.h });
    expect(JSON.stringify(list.json())).not.toContain(token);

    const n = await user('n@x.io');
    const acc = await app.inject({ method: 'POST', url: `/v1/invites/${token}/accept`, headers: n.h });
    expect(acc.statusCode).toBe(200);
    expect(acc.json()).toEqual({ orgId: org.id, role: 'MEMBER' });
    expect(await app.prisma.membership.count({ where: { orgId: org.id, userId: n.id } })).toBe(1);

    expect((await app.inject({ method: 'POST', url: `/v1/invites/${token}/accept`, headers: n.h })).statusCode).toBe(410);
  });

  it('403s acceptance by a user with a different email', async () => {
    const o = await user('o@x.io');
    const org = (await app.inject({ method: 'POST', url: '/v1/orgs', headers: o.h, payload: { name: 'A' } })).json();
    const { token } = (await app.inject({ method: 'POST', url: `/v1/orgs/${org.id}/invites`, headers: o.h, payload: { email: 'n@x.io', role: 'MEMBER' } })).json();
    const other = await user('other@x.io');
    expect((await app.inject({ method: 'POST', url: `/v1/invites/${token}/accept`, headers: other.h })).statusCode).toBe(403);
  });

  it('410s an expired invite', async () => {
    const o = await user('o@x.io');
    const org = (await app.inject({ method: 'POST', url: '/v1/orgs', headers: o.h, payload: { name: 'A' } })).json();
    const { token, id } = (await app.inject({ method: 'POST', url: `/v1/orgs/${org.id}/invites`, headers: o.h, payload: { email: 'n@x.io', role: 'MEMBER' } })).json();
    await app.prisma.invite.update({ where: { id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    const n = await user('n@x.io');
    expect((await app.inject({ method: 'POST', url: `/v1/invites/${token}/accept`, headers: n.h })).statusCode).toBe(410);
  });

  it('ADMIN cannot invite an OWNER; OWNER can', async () => {
    const o = await user('o@x.io'); const a = await user('a@x.io');
    const org = (await app.inject({ method: 'POST', url: '/v1/orgs', headers: o.h, payload: { name: 'A' } })).json();
    await app.prisma.membership.create({ data: { userId: a.id, orgId: org.id, role: 'ADMIN' } });
    expect((await app.inject({ method: 'POST', url: `/v1/orgs/${org.id}/invites`, headers: a.h, payload: { email: 'n@x.io', role: 'OWNER' } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: `/v1/orgs/${org.id}/invites`, headers: o.h, payload: { email: 'n@x.io', role: 'OWNER' } })).statusCode).toBe(201);
  });

  it('404s an unknown token and 409s an existing member', async () => {
    const o = await user('o@x.io');
    const org = (await app.inject({ method: 'POST', url: '/v1/orgs', headers: o.h, payload: { name: 'A' } })).json();
    expect((await app.inject({ method: 'POST', url: `/v1/invites/${'x'.repeat(43)}/accept`, headers: o.h })).statusCode).toBe(404);
    const { token } = (await app.inject({ method: 'POST', url: `/v1/orgs/${org.id}/invites`, headers: o.h, payload: { email: 'o@x.io', role: 'MEMBER' } })).json();
    expect((await app.inject({ method: 'POST', url: `/v1/invites/${token}/accept`, headers: o.h })).statusCode).toBe(409);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @query-analyser/api test -- invites`
Expected: FAIL.

- [ ] **Step 3: Implement**

`apps/api/src/orgs/invites.ts`:
```ts
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { createHash, randomBytes } from 'node:crypto';
import { requireRole } from './rbac.js';

const INVITE_TTL_MS = 7 * 24 * 3600 * 1000;
const createSchema = z.object({ email: z.string().email().max(200), role: z.enum(['OWNER', 'ADMIN', 'MEMBER', 'VIEWER']) });
const hashToken = (t: string) => createHash('sha256').update(t).digest('hex');

export async function inviteRoutes(app: FastifyInstance): Promise<void> {
  app.post('/v1/orgs/:org/invites', { preHandler: [app.authenticate, requireRole('ADMIN')] }, async (req, reply) => {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid body' });
    if (parsed.data.role === 'OWNER' && req.membership.role !== 'OWNER') {
      return reply.code(403).send({ error: 'only an owner can invite an owner' });
    }
    const token = randomBytes(32).toString('base64url');
    const row = await app.prisma.invite.create({
      data: { orgId: req.membership.orgId, email: parsed.data.email.toLowerCase(), role: parsed.data.role, tokenHash: hashToken(token), expiresAt: new Date(Date.now() + INVITE_TTL_MS) },
      select: { id: true, email: true, role: true, expiresAt: true },
    });
    return reply.code(201).send({ ...row, token });
  });

  app.get('/v1/orgs/:org/invites', { preHandler: [app.authenticate, requireRole('ADMIN')] }, async (req) =>
    app.prisma.invite.findMany({
      where: { orgId: req.membership.orgId, acceptedAt: null, expiresAt: { gt: new Date() } },
      select: { id: true, email: true, role: true, expiresAt: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
    }));

  app.post('/v1/invites/:token/accept', { preHandler: [app.authenticate] }, async (req, reply) => {
    const { token } = req.params as { token: string };
    const inv = await app.prisma.invite.findUnique({ where: { tokenHash: hashToken(token) } });
    if (!inv) return reply.code(404).send({ error: 'Not Found' });
    if (inv.acceptedAt || inv.expiresAt < new Date()) return reply.code(410).send({ error: 'invite no longer valid' });

    const me = await app.prisma.user.findUniqueOrThrow({ where: { id: req.user.id }, select: { email: true } });
    if (me.email !== inv.email) return reply.code(403).send({ error: 'invite was issued to a different email' });

    const already = await app.prisma.membership.findUnique({ where: { userId_orgId: { userId: req.user.id, orgId: inv.orgId } } });
    if (already) return reply.code(409).send({ error: 'already a member' });

    await app.prisma.$transaction([
      app.prisma.membership.create({ data: { userId: req.user.id, orgId: inv.orgId, role: inv.role } }),
      app.prisma.invite.update({ where: { id: inv.id }, data: { acceptedAt: new Date() } }),
    ]);
    return { orgId: inv.orgId, role: inv.role };
  });
}
```

Register `inviteRoutes` in `app.ts`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @query-analyser/api test -- invites`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src
git commit -m "feat(api): add single-use, email-bound organization invites"
```

---

### Task 11: Platform admin guard and minimal admin routes

**Files:**
- Create: `apps/api/src/admin/routes.ts`
- Modify: `apps/api/src/app.ts`, `apps/api/src/ingest/routes.ts` (ingest counters)
- Test: `apps/api/src/admin/routes.test.ts`

**Interfaces:**
- Produces: `app.requirePlatformAdmin` preHandler (401 unauthenticated, 404 non-admin — never reveal the surface exists); `GET /v1/admin/orgs` (id, name, slug, plan, suspendedAt, appCount, memberCount); `GET /v1/admin/orgs/:id` (+ apps with signature counts); `POST /v1/admin/orgs/:id/suspend` and `/unsuspend` → 204; `GET /v1/admin/health` → in-process ingest counters `{ batches, accepted, rejected401, rejected400, rejected429, since }`.
- The counters live on `app.ingestStats`, incremented in the ingest route. In-process only for v1 (one instance); Plan 3 can move them to a table.

- [ ] **Step 1: Write the failing test**

`apps/api/src/admin/routes.test.ts`:
```ts
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { buildApp } from '../app.js';
import { resetDb } from '../test/db.js';
import type { FastifyInstance } from 'fastify';

let app: FastifyInstance;
beforeAll(async () => { app = await buildApp({ logger: false }); });
beforeEach(async () => { await resetDb(app.prisma); });
afterAll(async () => { await app.close(); });

async function user(email: string, platformAdmin = false) {
  const s = await app.inject({ method: 'POST', url: '/v1/auth/signup', payload: { email, password: 'correct horse battery', name: email } });
  if (platformAdmin) await app.prisma.user.update({ where: { email }, data: { isPlatformAdmin: true } });
  return { id: s.json().user.id as string, h: { authorization: `Bearer ${s.json().accessToken}` } };
}

describe('admin', () => {
  it('404s non-admins and 401s anonymous', async () => {
    const u = await user('u@x.io');
    expect((await app.inject({ method: 'GET', url: '/v1/admin/orgs', headers: u.h })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/v1/admin/orgs' })).statusCode).toBe(401);
  });

  it('lists orgs with counts for a platform admin', async () => {
    const u = await user('u@x.io');
    await app.inject({ method: 'POST', url: '/v1/orgs', headers: u.h, payload: { name: 'Cust' } });
    const admin = await user('root@x.io', true);
    const res = await app.inject({ method: 'GET', url: '/v1/admin/orgs', headers: admin.h });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([expect.objectContaining({ name: 'Cust', appCount: 0, memberCount: 1, suspendedAt: null })]);
  });

  it('suspends and unsuspends an org, and suspension blocks the org members', async () => {
    const u = await user('u@x.io');
    const org = (await app.inject({ method: 'POST', url: '/v1/orgs', headers: u.h, payload: { name: 'Cust' } })).json();
    const admin = await user('root@x.io', true);
    expect((await app.inject({ method: 'POST', url: `/v1/admin/orgs/${org.id}/suspend`, headers: admin.h })).statusCode).toBe(204);
    expect((await app.inject({ method: 'GET', url: `/v1/orgs/${org.id}`, headers: u.h })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: `/v1/admin/orgs/${org.id}/unsuspend`, headers: admin.h })).statusCode).toBe(204);
    expect((await app.inject({ method: 'GET', url: `/v1/orgs/${org.id}`, headers: u.h })).statusCode).toBe(200);
  });

  it('reports ingest counters', async () => {
    const admin = await user('root@x.io', true);
    await app.inject({ method: 'POST', url: '/v1/ingest', headers: { authorization: 'Bearer nope' }, payload: {} });
    const res = await app.inject({ method: 'GET', url: '/v1/admin/health', headers: admin.h });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ batches: expect.any(Number), rejected401: expect.any(Number), since: expect.any(String) });
    expect(res.json().rejected401).toBeGreaterThanOrEqual(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @query-analyser/api test -- admin`
Expected: FAIL.

- [ ] **Step 3: Implement**

In `apps/api/src/plugins/auth.ts` add after `authenticate`:
```ts
  app.decorate('requirePlatformAdmin', async (req: FastifyRequest, reply: FastifyReply) => {
    // Verify the JWT here rather than delegating to `authenticate`: Fastify 5
    // has no reliable "was a reply already sent" flag to branch on afterwards.
    let userId: string;
    try {
      userId = (await req.jwtVerify<{ sub: string }>()).sub;
    } catch {
      await reply.code(401).send({ error: 'unauthorized' });
      return;
    }
    req.user = { id: userId };
    const u = await app.prisma.user.findUnique({ where: { id: userId }, select: { isPlatformAdmin: true } });
    if (!u?.isPlatformAdmin) await reply.code(404).send({ error: 'Not Found' });
  });
```
and add `requirePlatformAdmin` to the `FastifyInstance` augmentation.

In `apps/api/src/plugins/prisma.ts` add:
```ts
  app.decorate('ingestStats', { batches: 0, accepted: 0, rejected401: 0, rejected400: 0, rejected429: 0, since: new Date().toISOString() });
```
with the matching type `IngestStats` on the `FastifyInstance` augmentation. In `apps/api/src/ingest/routes.ts` increment `app.ingestStats.batches` at the top of the handler and the matching counter on each 401/400/429 branch; add `accepted += signatures` on success.

`apps/api/src/admin/routes.ts`:
```ts
import type { FastifyInstance } from 'fastify';

export async function adminRoutes(app: FastifyInstance): Promise<void> {
  const guard = { preHandler: [app.requirePlatformAdmin] };

  app.get('/v1/admin/orgs', guard, async () => {
    const rows = await app.prisma.organization.findMany({
      select: { id: true, name: true, slug: true, plan: true, suspendedAt: true, createdAt: true, _count: { select: { apps: true, memberships: true } } },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map(({ _count, ...o }) => ({ ...o, appCount: _count.apps, memberCount: _count.memberships }));
  });

  app.get('/v1/admin/orgs/:id', guard, async (req, reply) => {
    const { id } = req.params as { id: string };
    const org = await app.prisma.organization.findUnique({
      where: { id },
      select: { id: true, name: true, slug: true, plan: true, suspendedAt: true, createdAt: true,
        apps: { select: { id: true, name: true, env: true, _count: { select: { signatures: true } } } } },
    });
    if (!org) return reply.code(404).send({ error: 'Not Found' });
    return { ...org, apps: org.apps.map(({ _count, ...a }) => ({ ...a, signatureCount: _count.signatures })) };
  });

  for (const [path, value] of [['suspend', () => new Date()], ['unsuspend', () => null]] as const) {
    app.post(`/v1/admin/orgs/:id/${path}`, guard, async (req, reply) => {
      const { id } = req.params as { id: string };
      const r = await app.prisma.organization.updateMany({ where: { id }, data: { suspendedAt: value() } });
      if (r.count === 0) return reply.code(404).send({ error: 'Not Found' });
      return reply.code(204).send();
    });
  }

  app.get('/v1/admin/health', guard, async () => app.ingestStats);
}
```

Register `adminRoutes` in `app.ts`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @query-analyser/api test -- admin`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src
git commit -m "feat(api): add platform-admin guard, org suspension and ingest health counters"
```

---

### Task 12: Docker build proof and README

**Files:**
- Create: `apps/api/README.md`
- Modify: `apps/api/Dockerfile` if the build proves something wrong; root `turbo.json` (add `db:generate` before `build` for the api)

**Interfaces:** none new. This is the deploy gate for Easypanel.

- [ ] **Step 1: Prove the image builds and boots**

From the repo root:
```bash
docker compose up -d postgres
docker build -f apps/api/Dockerfile -t query-analyser-api:local .
docker run --rm --network host \
  -e DATABASE_URL=postgresql://qa:qa@localhost:5432/qa \
  -e JWT_SECRET=$(openssl rand -hex 32) -e COOKIE_SECRET=$(openssl rand -hex 32) \
  -e PORT=8080 query-analyser-api:local &
sleep 8 && curl -s localhost:8080/healthz && echo
```
Expected: `{"status":"ok"}`. Migrations apply on start (`pnpm db:deploy` in `CMD`). Kill the container after.

If `prisma generate` fails inside the image because the generator needs a platform binary, add `binaryTargets = ["native", "linux-musl-openssl-3.0.x"]` to the generator block — but with Prisma 7's `prisma-client` generator and a driver adapter no engine binary is needed; check the actual error before adding anything.

- [ ] **Step 2: turbo ordering**

In root `turbo.json`, add:
```json
"db:generate": { "cache": false },
"build": { "dependsOn": ["^build", "db:generate"], "outputs": ["dist/**"] }
```
so `pnpm build` at the root generates the Prisma client before compiling the API. Packages without a `db:generate` script are skipped by turbo.

- [ ] **Step 3: README**

`apps/api/README.md`:
````markdown
# query-analyser API

Ingest + auth + tenancy for `@vivekumar08/query-analyser`.

## Run locally
```bash
docker compose up -d postgres
cp apps/api/.env.example apps/api/.env
pnpm --filter @query-analyser/api db:migrate   # first time
pnpm --filter @query-analyser/api db:generate
pnpm --filter @query-analyser/api dev
```

## Test
```bash
docker compose up -d postgres
pnpm --filter @query-analyser/api test
```
Tests run against the real database in `DATABASE_URL` and truncate all tables between tests. Point it at a throwaway database.

## Deploy (Easypanel / any Docker host)
Build context is the repo root; Dockerfile is `apps/api/Dockerfile`. Required env:

| var | purpose |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string |
| `JWT_SECRET` | ≥32 chars; signs 15-minute access tokens |
| `COOKIE_SECRET` | ≥32 chars; signs the refresh cookie |
| `PORT` | default 8080 |
| `NODE_ENV` | `production` makes the refresh cookie `Secure` |

The container runs `prisma migrate deploy` then starts. Put it behind TLS and point `ingest.query-analyser.dev` (the SDK's default endpoint) at it.

## Routes
See `docs/superpowers/specs/2026-09-20-query-analyser-design.md` §5. Everything under `/v1/orgs`, `/v1/apps` requires `Authorization: Bearer <access token>`; `/v1/ingest` requires an ingest key; `/v1/admin/*` requires `isPlatformAdmin` (set directly in the database for now).

## First platform admin
```sql
UPDATE "User" SET "isPlatformAdmin" = true WHERE email = 'you@example.com';
```
````

- [ ] **Step 4: Full suite and commit**

Run: `pnpm test && pnpm typecheck`
Expected: all packages green.

```bash
git add apps/api/README.md apps/api/Dockerfile turbo.json
git commit -m "docs(api): add README and deploy notes; wire prisma generate into turbo build"
```

---

## Verification

- [ ] `pnpm test` green in `contract`, `sdk`, `api`.
- [ ] `pnpm typecheck` green.
- [ ] The e2e test (Task 6) passes using the **published** `@vivekumar08/query-analyser@0.1.0`, not the workspace package.
- [ ] `docker build` succeeds and `/healthz` answers from the container.
- [ ] Manual smoke against the running container: signup → create org → create app → create key → point a local Node script with the SDK at `http://localhost:8080/v1/ingest` → `SELECT count(*) FROM "QueryRollup"` is > 0.

## What Plan 3 consumes from this

`QuerySignature`, `QueryRollup`, `QueryDailyRollup`, `Alert`, `Advice` tables exactly as migrated here; `requireAppRole`/`requireRole` guards; `app.prisma`; the `hist` column as an 8-element `int[]` for percentile maths.
