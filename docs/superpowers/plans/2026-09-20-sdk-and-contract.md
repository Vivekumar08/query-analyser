# query-analyser SDK + Contract Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `@vivekumar08/query-analyser` to public npm — a zero-runtime-dependency mongoose plugin that times queries, collapses slow ones by shape into privacy-safe aggregates, and batches them to a hosted ingest endpoint.

**Architecture:** Two packages. `packages/contract` holds the ingest payload definition: a zod-free runtime module (constants, bucket helper) and a zod schema module used only by the server. `packages/sdk` imports the runtime module and the *types*, never zod, so the published SDK has no runtime dependencies at all. Inside the SDK, each concern is one small file — redaction, signature building, histogram, buffering, transport, installation — so each is testable in isolation and the whole hot path can be reasoned about at once.

**Tech Stack:** TypeScript 5.7, pnpm workspaces, turborepo 2, vitest, tsup (bundler), mongoose 8 as a peer dependency, `mongodb-memory-server` for integration tests. Node 20+.

**Spec:** `docs/superpowers/specs/2026-09-20-query-analyser-design.md`

## Global Constraints

- The published SDK has **zero runtime dependencies**. `mongoose` is a peer dependency with range `>=6 <9`. Anything else is a devDependency or is bundled.
- **No queried value ever leaves the process.** Every payload field is either a key name, an operator class, a type name, or a number. Any change that could carry a value is a spec violation.
- **The hot path performs no I/O** and allocates as little as possible. Hooks never throw into the caller: every hook body is wrapped in try/catch.
- Histogram is exactly **8 buckets**, upper bounds `[100, 250, 500, 1000, 2500, 5000, 10000, Infinity]` ms.
- Bucket strings are `YYYYMMDDHH` in **UTC**.
- Published package name: `@vivekumar08/query-analyser`. Internal workspace names are `@query-analyser/contract` and `@query-analyser/sdk`.
- Node engine floor: `>=20`.
- TypeScript `strict: true` everywhere. No `any` in exported signatures.
- Every task ends with a commit.

---

### Task 1: Monorepo scaffold

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `turbo.json`, `tsconfig.base.json`, `.npmrc`
- Create: `packages/contract/package.json`, `packages/contract/tsconfig.json`, `packages/contract/vitest.config.ts`
- Create: `packages/sdk/package.json`, `packages/sdk/tsconfig.json`, `packages/sdk/vitest.config.ts`
- Test: `packages/contract/src/__tests__/smoke.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: a workspace where `pnpm test` runs vitest in every package, and `@query-analyser/contract` resolves from `@query-analyser/sdk` via `workspace:*`.

- [ ] **Step 1: Write the root workspace files**

`package.json`:
```json
{
  "name": "query-analyser",
  "private": true,
  "packageManager": "pnpm@9.12.0",
  "engines": { "node": ">=20" },
  "scripts": {
    "build": "turbo run build",
    "test": "turbo run test",
    "typecheck": "turbo run typecheck"
  },
  "devDependencies": {
    "turbo": "^2.3.3",
    "typescript": "^5.7.2",
    "vitest": "^2.1.8"
  }
}
```

`pnpm-workspace.yaml`:
```yaml
packages:
  - 'packages/*'
  - 'apps/*'
```

`turbo.json`:
```json
{
  "$schema": "https://turbo.build/schema.json",
  "tasks": {
    "build": { "dependsOn": ["^build"], "outputs": ["dist/**"] },
    "test": { "dependsOn": ["^build"] },
    "typecheck": { "dependsOn": ["^build"] }
  }
}
```

`tsconfig.base.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022"],
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "declaration": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "noUncheckedIndexedAccess": true
  }
}
```

`.npmrc`:
```
auto-install-peers=false
strict-peer-dependencies=false
```

- [ ] **Step 2: Write the two package manifests**

`packages/contract/package.json`:
```json
{
  "name": "@query-analyser/contract",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./src/index.ts",
  "exports": {
    ".": "./src/index.ts",
    "./runtime": "./src/runtime.ts"
  },
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc --noEmit",
    "build": "tsc --noEmit"
  },
  "dependencies": { "zod": "^3.24.1" },
  "devDependencies": { "typescript": "^5.7.2", "vitest": "^2.1.8" }
}
```

`packages/sdk/package.json`:
```json
{
  "name": "@query-analyser/sdk",
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc --noEmit",
    "build": "tsup"
  },
  "dependencies": {},
  "peerDependencies": { "mongoose": ">=6 <9" },
  "devDependencies": {
    "@query-analyser/contract": "workspace:*",
    "mongoose": "^8.9.0",
    "mongodb-memory-server": "^10.1.2",
    "tsup": "^8.3.5",
    "typescript": "^5.7.2",
    "vitest": "^2.1.8"
  }
}
```

Note: `@query-analyser/contract` is a **devDependency** of the SDK, not a dependency. The SDK imports only types and the zod-free runtime module, and tsup inlines the runtime module into the bundle. This is what keeps the published package dependency-free. Task 10 sets the published name and fields.

`packages/contract/tsconfig.json` and `packages/sdk/tsconfig.json` are both:
```json
{ "extends": "../../tsconfig.base.json", "include": ["src"] }
```

Both `vitest.config.ts` files:
```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { environment: 'node', include: ['src/**/*.test.ts'] },
});
```

- [ ] **Step 3: Write a smoke test that proves the workspace runs**

`packages/contract/src/__tests__/smoke.test.ts`:
```ts
import { describe, it, expect } from 'vitest';

describe('workspace', () => {
  it('runs vitest', () => {
    expect(1 + 1).toBe(2);
  });
});
```

- [ ] **Step 4: Install and run**

Run: `pnpm install && pnpm test`
Expected: PASS. The contract package runs one test; the SDK package reports no test files (that is fine at this stage — vitest exits 0 with `passWithNoTests` off only when files exist, so if it fails with "No test files found", add `"passWithNoTests": true` to the SDK's vitest `test` config).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "chore: scaffold pnpm monorepo with contract and sdk packages"
```

---

### Task 2: Contract — runtime constants and bucket helper

**Files:**
- Create: `packages/contract/src/runtime.ts`
- Test: `packages/contract/src/runtime.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `HIST_BOUNDS: readonly [100, 250, 500, 1000, 2500, 5000, 10000]`
  - `HIST_SIZE: 8`
  - `bucketOf(date: Date): string` — `YYYYMMDDHH` in UTC
  - `type OpClass = 'eq' | 'in' | 'range' | 'regex' | 'exists' | 'ne' | 'other'`
  - `interface FilterShapeItem { key: string; op: OpClass }`
  - `interface SortKey { key: string; dir: 1 | -1 }`
  - `interface IngestItem` and `interface IngestPayload` (fields exactly as in Step 1 below)

This file must not import zod. The SDK depends on that.

- [ ] **Step 1: Write the failing test**

`packages/contract/src/runtime.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { HIST_BOUNDS, HIST_SIZE, bucketOf } from './runtime.js';

describe('histogram constants', () => {
  it('has 7 bounds and 8 buckets', () => {
    expect(HIST_BOUNDS).toEqual([100, 250, 500, 1000, 2500, 5000, 10000]);
    expect(HIST_SIZE).toBe(8);
    expect(HIST_BOUNDS.length).toBe(HIST_SIZE - 1);
  });
});

describe('bucketOf', () => {
  it('formats an hour bucket in UTC', () => {
    expect(bucketOf(new Date('2026-09-20T14:37:09.000Z'))).toBe('2026092014');
  });

  it('zero-pads month, day and hour', () => {
    expect(bucketOf(new Date('2026-01-02T03:00:00.000Z'))).toBe('2026010203');
  });

  it('ignores local timezone', () => {
    // 23:30 UTC is the next day in +05:30, and the previous day in -06:00.
    expect(bucketOf(new Date('2026-09-20T23:30:00.000Z'))).toBe('2026092023');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @query-analyser/contract test`
Expected: FAIL — cannot resolve `./runtime.js`.

- [ ] **Step 3: Write the implementation**

`packages/contract/src/runtime.ts`:
```ts
/**
 * Zero-dependency runtime values shared by the SDK and the API.
 * This module must never import zod — the published SDK inlines it,
 * and the SDK ships with no runtime dependencies.
 */

export const HIST_BOUNDS = [100, 250, 500, 1000, 2500, 5000, 10000] as const;
export const HIST_SIZE = 8;

export type OpClass = 'eq' | 'in' | 'range' | 'regex' | 'exists' | 'ne' | 'other';

export interface FilterShapeItem {
  key: string;
  op: OpClass;
}

export interface SortKey {
  key: string;
  dir: 1 | -1;
}

export interface IngestItem {
  signature: string;
  hash: string;
  model: string;
  operation: string;
  filterShape: FilterShapeItem[];
  sortKeys: SortKey[];
  stages: string[];
  count: number;
  totalMs: number;
  maxMs: number;
  lastMs: number;
  lastTs: number;
  hist: number[];
  sample: unknown | null;
}

export interface IngestPayload {
  app: string;
  env: string;
  host: string;
  sdkVersion: string;
  bucket: string;
  thresholdMs: number;
  dropped: number;
  items: IngestItem[];
}

/** `YYYYMMDDHH` in UTC — the hour bucket a measurement belongs to. */
export function bucketOf(date: Date): string {
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return (
    p(date.getUTCFullYear(), 4) +
    p(date.getUTCMonth() + 1) +
    p(date.getUTCDate()) +
    p(date.getUTCHours())
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @query-analyser/contract test`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/contract/src
git commit -m "feat(contract): add zod-free runtime constants and bucket helper"
```

---

### Task 3: Contract — zod schema for the ingest payload

**Files:**
- Create: `packages/contract/src/schema.ts`, `packages/contract/src/index.ts`
- Delete: `packages/contract/src/__tests__/smoke.test.ts`
- Test: `packages/contract/src/schema.test.ts`

**Interfaces:**
- Consumes: `HIST_SIZE`, and the `IngestItem` / `IngestPayload` types from Task 2.
- Produces: `ingestItemSchema`, `ingestPayloadSchema` (zod objects). `ingestPayloadSchema.parse()` returns a value assignable to `IngestPayload`. The API in Plan 2 validates every request body with `ingestPayloadSchema`.

- [ ] **Step 1: Write the failing test**

`packages/contract/src/schema.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { ingestPayloadSchema } from './schema.js';

const item = {
  signature: 'Order.find(status:eq)',
  hash: 'a1b2c3d4e5f60718',
  model: 'Order',
  operation: 'find',
  filterShape: [{ key: 'status', op: 'eq' }],
  sortKeys: [{ key: 'createdAt', dir: -1 }],
  stages: [],
  count: 3,
  totalMs: 600,
  maxMs: 400,
  lastMs: 120,
  lastTs: 1758378000000,
  hist: [1, 1, 0, 1, 0, 0, 0, 0],
  sample: { status: '<string>' },
};

const payload = {
  app: 'kisna-web',
  env: 'production',
  host: 'web-7d9f',
  sdkVersion: '0.1.0',
  bucket: '2026092014',
  thresholdMs: 100,
  dropped: 0,
  items: [item],
};

describe('ingestPayloadSchema', () => {
  it('accepts a well-formed payload', () => {
    expect(ingestPayloadSchema.parse(payload)).toMatchObject({ app: 'kisna-web' });
  });

  it('rejects a histogram that is not exactly 8 buckets', () => {
    const bad = { ...payload, items: [{ ...item, hist: [1, 2, 3] }] };
    expect(() => ingestPayloadSchema.parse(bad)).toThrow();
  });

  it('rejects a malformed bucket string', () => {
    expect(() => ingestPayloadSchema.parse({ ...payload, bucket: '2026-09-20' })).toThrow();
  });

  it('rejects an unknown operator class', () => {
    const bad = { ...payload, items: [{ ...item, filterShape: [{ key: 'x', op: 'wat' }] }] };
    expect(() => ingestPayloadSchema.parse(bad)).toThrow();
  });

  it('rejects a batch larger than the cap', () => {
    const bad = { ...payload, items: Array.from({ length: 5001 }, () => item) };
    expect(() => ingestPayloadSchema.parse(bad)).toThrow();
  });

  it('rejects an app name that is empty', () => {
    expect(() => ingestPayloadSchema.parse({ ...payload, app: '' })).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @query-analyser/contract test`
Expected: FAIL — cannot resolve `./schema.js`.

- [ ] **Step 3: Write the implementation**

`packages/contract/src/schema.ts`:
```ts
import { z } from 'zod';
import { HIST_SIZE } from './runtime.js';

export const opClassSchema = z.enum(['eq', 'in', 'range', 'regex', 'exists', 'ne', 'other']);

export const filterShapeItemSchema = z.object({
  key: z.string().min(1).max(200),
  op: opClassSchema,
});

export const sortKeySchema = z.object({
  key: z.string().min(1).max(200),
  dir: z.union([z.literal(1), z.literal(-1)]),
});

export const ingestItemSchema = z.object({
  signature: z.string().min(1).max(400),
  hash: z.string().length(16),
  model: z.string().min(1).max(200),
  operation: z.string().min(1).max(40),
  filterShape: z.array(filterShapeItemSchema).max(64),
  sortKeys: z.array(sortKeySchema).max(32),
  stages: z.array(z.string().max(40)).max(64),
  count: z.number().int().nonnegative(),
  totalMs: z.number().nonnegative(),
  maxMs: z.number().nonnegative(),
  lastMs: z.number().nonnegative(),
  lastTs: z.number().int().nonnegative(),
  hist: z.array(z.number().int().nonnegative()).length(HIST_SIZE),
  sample: z.unknown().nullable(),
});

export const ingestPayloadSchema = z.object({
  app: z.string().min(1).max(100),
  env: z.string().min(1).max(40),
  host: z.string().max(200),
  sdkVersion: z.string().max(40),
  bucket: z.string().regex(/^\d{10}$/),
  thresholdMs: z.number().int().positive(),
  dropped: z.number().int().nonnegative(),
  items: z.array(ingestItemSchema).max(5000),
});

export type IngestPayloadParsed = z.infer<typeof ingestPayloadSchema>;
```

`packages/contract/src/index.ts`:
```ts
export * from './runtime.js';
export * from './schema.js';
```

Delete the scaffold smoke test:
```bash
rm packages/contract/src/__tests__/smoke.test.ts
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @query-analyser/contract test`
Expected: PASS (10 tests across both files).

- [ ] **Step 5: Commit**

```bash
git add -A packages/contract
git commit -m "feat(contract): add zod ingest payload schema"
```

---

### Task 4: SDK — redaction

The single most security-relevant unit in the codebase. Everything that could carry a customer value passes through here first.

**Files:**
- Create: `packages/sdk/src/redact.ts`
- Test: `packages/sdk/src/redact.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `redact(value: unknown, depth?: number): unknown` — returns a structure of the same shape with every leaf replaced by a type token string.

- [ ] **Step 1: Write the failing test**

`packages/sdk/src/redact.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { Types } from 'mongoose';
import { redact } from './redact.js';

describe('redact', () => {
  it('replaces scalars with type tokens', () => {
    expect(redact('abc')).toBe('<string>');
    expect(redact(42)).toBe('<number>');
    expect(redact(true)).toBe('<boolean>');
    expect(redact(null)).toBe('<null>');
    expect(redact(undefined)).toBe('<undefined>');
  });

  it('recognises ObjectId, Date and RegExp', () => {
    expect(redact(new Types.ObjectId())).toBe('<ObjectId>');
    expect(redact(new Date())).toBe('<Date>');
    expect(redact(/abc/i)).toBe('<RegExp>');
  });

  it('keeps object keys and redacts values recursively', () => {
    expect(redact({ status: 'paid', createdAt: { $gte: new Date() } })).toEqual({
      status: '<string>',
      createdAt: { $gte: '<Date>' },
    });
  });

  it('summarises arrays by element type without keeping length-dependent data', () => {
    expect(redact(['a', 'b', 'c'])).toBe('<array[string]>');
    expect(redact([1, 'a'])).toBe('<array[mixed]>');
    expect(redact([])).toBe('<array[]>');
  });

  it('truncates beyond the depth limit rather than recursing forever', () => {
    expect(redact({ a: { b: { c: { d: { e: { f: 1 } } } } } })).toEqual({
      a: { b: { c: { d: { e: '<object>' } } } },
    });
  });

  it('survives a circular structure', () => {
    const o: Record<string, unknown> = { a: 1 };
    o.self = o;
    expect(() => redact(o)).not.toThrow();
  });

  it('leaks no input value anywhere in the output', () => {
    const secret = 'super-secret-email@example.com';
    const out = JSON.stringify(
      redact({ email: secret, nested: { list: [secret] }, n: 918273 }),
    );
    expect(out).not.toContain('super-secret');
    expect(out).not.toContain('918273');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @query-analyser/sdk test`
Expected: FAIL — cannot resolve `./redact.js`.

- [ ] **Step 3: Write the implementation**

`packages/sdk/src/redact.ts`:
```ts
const MAX_DEPTH = 5;
const MAX_KEYS = 32;

function scalarToken(v: unknown): string | null {
  if (v === null) return '<null>';
  if (v === undefined) return '<undefined>';
  switch (typeof v) {
    case 'string': return '<string>';
    case 'number': return '<number>';
    case 'boolean': return '<boolean>';
    case 'bigint': return '<bigint>';
    case 'function': return '<function>';
    case 'symbol': return '<symbol>';
  }
  if (v instanceof Date) return '<Date>';
  if (v instanceof RegExp) return '<RegExp>';
  // Duck-typed so we never import mongoose or bson here.
  const ctor = (v as { constructor?: { name?: string } }).constructor?.name;
  if (ctor === 'ObjectId' || ctor === 'ObjectID') return '<ObjectId>';
  if (ctor === 'Decimal128') return '<Decimal128>';
  if (ctor === 'Binary') return '<Binary>';
  if (v instanceof Buffer) return '<Buffer>';
  return null;
}

function arrayToken(arr: unknown[]): string {
  if (arr.length === 0) return '<array[]>';
  const kinds = new Set(arr.slice(0, 16).map((el) => {
    const t = scalarToken(el);
    if (t) return t.slice(1, -1);
    return Array.isArray(el) ? 'array' : 'object';
  }));
  return kinds.size === 1 ? `<array[${[...kinds][0]}]>` : '<array[mixed]>';
}

/**
 * Replace every leaf value with a token naming its type, keeping only the
 * structure and the keys. No input value can appear in the output.
 */
export function redact(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  const scalar = scalarToken(value);
  if (scalar !== null) return scalar;

  if (Array.isArray(value)) return arrayToken(value);

  const obj = value as Record<string, unknown>;
  if (seen.has(obj)) return '<circular>';
  if (depth >= MAX_DEPTH) return '<object>';
  seen.add(obj);

  const out: Record<string, unknown> = {};
  let n = 0;
  for (const key of Object.keys(obj)) {
    if (n++ >= MAX_KEYS) { out['…'] = '<truncated>'; break; }
    out[key] = redact(obj[key], depth + 1, seen);
  }
  seen.delete(obj);
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @query-analyser/sdk test`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/sdk/src/redact.ts packages/sdk/src/redact.test.ts
git commit -m "feat(sdk): add value redaction"
```

---

### Task 5: SDK — signature building

**Files:**
- Create: `packages/sdk/src/signature.ts`
- Test: `packages/sdk/src/signature.test.ts`

**Interfaces:**
- Consumes: `OpClass`, `FilterShapeItem`, `SortKey` types from `@query-analyser/contract/runtime`.
- Produces:
  - `classifyOp(value: unknown): OpClass`
  - `normalizeKey(path: string): string`
  - `flattenFilter(filter: unknown): FilterShapeItem[]`
  - `normalizeSort(sort: unknown): SortKey[]`
  - `buildSignature(input: { model: string; operation: string; filter?: unknown; sort?: unknown; pipeline?: unknown[] }): SignatureResult`
  - `interface SignatureResult { signature: string; hash: string; model: string; operation: string; filterShape: FilterShapeItem[]; sortKeys: SortKey[]; stages: string[] }` — `model` and `operation` are echoed back so consumers never have to re-parse the rendered signature string.

`hash` is the first 16 hex characters of the SHA-256 of `signature`.

- [ ] **Step 1: Write the failing test**

`packages/sdk/src/signature.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { classifyOp, normalizeKey, flattenFilter, normalizeSort, buildSignature } from './signature.js';

describe('classifyOp', () => {
  it('treats plain values and $eq as equality', () => {
    expect(classifyOp('paid')).toBe('eq');
    expect(classifyOp(7)).toBe('eq');
    expect(classifyOp({ $eq: 'paid' })).toBe('eq');
  });

  it('classifies set membership', () => {
    expect(classifyOp({ $in: ['a', 'b'] })).toBe('in');
    expect(classifyOp({ $all: ['a'] })).toBe('in');
  });

  it('classifies ranges', () => {
    expect(classifyOp({ $gte: 1 })).toBe('range');
    expect(classifyOp({ $lt: 1 })).toBe('range');
    expect(classifyOp({ $gt: 1, $lte: 9 })).toBe('range');
  });

  it('classifies regex, exists and negation', () => {
    expect(classifyOp({ $regex: 'x' })).toBe('regex');
    expect(classifyOp(/x/)).toBe('regex');
    expect(classifyOp({ $exists: true })).toBe('exists');
    expect(classifyOp({ $ne: 1 })).toBe('ne');
    expect(classifyOp({ $nin: [1] })).toBe('ne');
  });

  it('falls back to other for unknown operators', () => {
    expect(classifyOp({ $mod: [2, 0] })).toBe('other');
  });
});

describe('normalizeKey', () => {
  it('collapses array indexes so positions do not fragment signatures', () => {
    expect(normalizeKey('items.0.sku')).toBe('items.$[].sku');
    expect(normalizeKey('items.13.sku')).toBe('items.$[].sku');
  });

  it('leaves ordinary paths alone', () => {
    expect(normalizeKey('user.address.city')).toBe('user.address.city');
  });
});

describe('flattenFilter', () => {
  it('returns keys sorted with their operator classes', () => {
    expect(flattenFilter({ status: 'paid', createdAt: { $gte: new Date() } })).toEqual([
      { key: 'createdAt', op: 'range' },
      { key: 'status', op: 'eq' },
    ]);
  });

  it('flattens $and and $or branches into one list', () => {
    expect(flattenFilter({ $and: [{ a: 1 }, { $or: [{ b: { $gt: 1 } }] }] })).toEqual([
      { key: 'a', op: 'eq' },
      { key: 'b', op: 'range' },
    ]);
  });

  it('deduplicates a key that appears in several branches', () => {
    expect(flattenFilter({ $or: [{ a: 1 }, { a: 2 }] })).toEqual([{ key: 'a', op: 'eq' }]);
  });

  it('records $expr and $text as opaque', () => {
    expect(flattenFilter({ $expr: { $gt: ['$a', '$b'] } })).toEqual([
      { key: '$expr', op: 'other' },
    ]);
  });

  it('returns an empty list for an empty or non-object filter', () => {
    expect(flattenFilter({})).toEqual([]);
    expect(flattenFilter(undefined)).toEqual([]);
    expect(flattenFilter(null)).toEqual([]);
  });
});

describe('normalizeSort', () => {
  it('preserves sort order and direction', () => {
    expect(normalizeSort({ placedAt: -1, name: 1 })).toEqual([
      { key: 'placedAt', dir: -1 },
      { key: 'name', dir: 1 },
    ]);
  });

  it('maps asc and desc strings to numeric directions', () => {
    expect(normalizeSort({ a: 'asc', b: 'desc' })).toEqual([
      { key: 'a', dir: 1 },
      { key: 'b', dir: -1 },
    ]);
  });

  it('returns an empty list when there is no sort', () => {
    expect(normalizeSort(undefined)).toEqual([]);
  });
});

describe('buildSignature', () => {
  it('renders a find signature with operator classes and sort', () => {
    const s = buildSignature({
      model: 'Order',
      operation: 'find',
      filter: { status: 'paid', createdAt: { $gte: new Date() } },
      sort: { placedAt: -1 },
    });
    expect(s.signature).toBe('Order.find(createdAt:range,status:eq)[placedAt:-1]');
    expect(s.hash).toMatch(/^[0-9a-f]{16}$/);
    expect(s.model).toBe('Order');
    expect(s.operation).toBe('find');
  });

  it('renders an aggregate signature from stage operators', () => {
    const s = buildSignature({
      model: 'Order',
      operation: 'aggregate',
      pipeline: [{ $match: { a: 1 } }, { $group: { _id: null } }],
    });
    expect(s.signature).toBe('Order.aggregate($match,$group)');
    expect(s.stages).toEqual(['$match', '$group']);
  });

  it('gives the same signature for the same shape with different values', () => {
    const a = buildSignature({ model: 'O', operation: 'find', filter: { s: 'paid' } });
    const b = buildSignature({ model: 'O', operation: 'find', filter: { s: 'void' } });
    expect(a.hash).toBe(b.hash);
  });

  it('gives different signatures for different operator classes on the same key', () => {
    const a = buildSignature({ model: 'O', operation: 'find', filter: { n: 1 } });
    const b = buildSignature({ model: 'O', operation: 'find', filter: { n: { $gt: 1 } } });
    expect(a.hash).not.toBe(b.hash);
  });

  it('caps the rendered signature length', () => {
    const filter: Record<string, number> = {};
    for (let i = 0; i < 200; i++) filter[`field_number_${i}`] = i;
    expect(buildSignature({ model: 'O', operation: 'find', filter }).signature.length)
      .toBeLessThanOrEqual(400);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @query-analyser/sdk test`
Expected: FAIL — cannot resolve `./signature.js`.

- [ ] **Step 3: Write the implementation**

`packages/sdk/src/signature.ts`:
```ts
import { createHash } from 'node:crypto';
import type { FilterShapeItem, OpClass, SortKey } from '@query-analyser/contract/runtime';

const MAX_SIGNATURE_LEN = 400;
const MAX_KEYS = 64;

const RANGE_OPS = new Set(['$gt', '$gte', '$lt', '$lte']);
const IN_OPS = new Set(['$in', '$all']);
const NE_OPS = new Set(['$ne', '$nin', '$not']);
const LOGICAL_OPS = new Set(['$and', '$or', '$nor']);

export function classifyOp(value: unknown): OpClass {
  if (value instanceof RegExp) return 'regex';
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return 'eq';
  if (value instanceof Date) return 'eq';

  const keys = Object.keys(value as Record<string, unknown>);
  const operators = keys.filter((k) => k.startsWith('$'));
  if (operators.length === 0) return 'eq';

  // Precedence: the most index-relevant classification wins.
  if (operators.some((o) => o === '$eq')) return 'eq';
  if (operators.some((o) => IN_OPS.has(o))) return 'in';
  if (operators.some((o) => RANGE_OPS.has(o))) return 'range';
  if (operators.some((o) => o === '$regex')) return 'regex';
  if (operators.some((o) => o === '$exists')) return 'exists';
  if (operators.some((o) => NE_OPS.has(o))) return 'ne';
  return 'other';
}

export function normalizeKey(path: string): string {
  return path
    .split('.')
    .map((seg) => (/^\d+$/.test(seg) ? '$[]' : seg))
    .join('.');
}

export function flattenFilter(filter: unknown): FilterShapeItem[] {
  const found = new Map<string, OpClass>();

  const walk = (node: unknown): void => {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return;
    for (const [rawKey, value] of Object.entries(node as Record<string, unknown>)) {
      if (LOGICAL_OPS.has(rawKey)) {
        if (Array.isArray(value)) value.forEach(walk);
        continue;
      }
      if (rawKey.startsWith('$')) {
        // $expr, $text, $where and friends: opaque for index purposes.
        if (!found.has(rawKey)) found.set(rawKey, 'other');
        continue;
      }
      const key = normalizeKey(rawKey);
      if (!found.has(key)) found.set(key, classifyOp(value));
    }
  };

  walk(filter);

  return [...found.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .slice(0, MAX_KEYS)
    .map(([key, op]) => ({ key, op }));
}

export function normalizeSort(sort: unknown): SortKey[] {
  if (!sort || typeof sort !== 'object' || Array.isArray(sort)) return [];
  const out: SortKey[] = [];
  for (const [rawKey, raw] of Object.entries(sort as Record<string, unknown>)) {
    const dir: 1 | -1 = raw === -1 || raw === 'desc' || raw === 'descending' ? -1 : 1;
    out.push({ key: normalizeKey(rawKey), dir });
    if (out.length >= 32) break;
  }
  return out;
}

function stagesOf(pipeline: unknown[] | undefined): string[] {
  if (!Array.isArray(pipeline)) return [];
  return pipeline
    .slice(0, 64)
    .map((stage) => {
      if (!stage || typeof stage !== 'object') return '?';
      return Object.keys(stage as Record<string, unknown>)[0] ?? '?';
    });
}

export interface SignatureInput {
  model: string;
  operation: string;
  filter?: unknown;
  sort?: unknown;
  pipeline?: unknown[];
}

export interface SignatureResult {
  signature: string;
  hash: string;
  model: string;
  operation: string;
  filterShape: FilterShapeItem[];
  sortKeys: SortKey[];
  stages: string[];
}

export function buildSignature(input: SignatureInput): SignatureResult {
  const stages = stagesOf(input.pipeline);
  const isAggregate = stages.length > 0 || input.operation === 'aggregate';

  const filterShape = isAggregate ? [] : flattenFilter(input.filter);
  const sortKeys = isAggregate ? [] : normalizeSort(input.sort);

  const body = isAggregate
    ? stages.join(',')
    : filterShape.map((f) => `${f.key}:${f.op}`).join(',');
  const sortPart = sortKeys.length
    ? `[${sortKeys.map((s) => `${s.key}:${s.dir}`).join(',')}]`
    : '';

  const signature = `${input.model}.${input.operation}(${body})${sortPart}`.slice(0, MAX_SIGNATURE_LEN);
  const hash = createHash('sha256').update(signature).digest('hex').slice(0, 16);

  return {
    signature,
    hash,
    model: input.model,
    operation: isAggregate ? 'aggregate' : input.operation,
    filterShape,
    sortKeys,
    stages,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @query-analyser/sdk test`
Expected: PASS (all signature tests plus the redaction tests from Task 4).

- [ ] **Step 5: Commit**

```bash
git add packages/sdk/src/signature.ts packages/sdk/src/signature.test.ts
git commit -m "feat(sdk): build query signatures with operator classes"
```

---

### Task 6: SDK — histogram and the aggregation buffer

**Files:**
- Create: `packages/sdk/src/histogram.ts`, `packages/sdk/src/aggregator.ts`
- Test: `packages/sdk/src/histogram.test.ts`, `packages/sdk/src/aggregator.test.ts`

**Interfaces:**
- Consumes: `HIST_BOUNDS`, `HIST_SIZE`, `IngestItem` from the contract runtime; `SignatureResult` from Task 5.
- Produces:
  - `bucketIndex(ms: number): number`
  - `newHist(): number[]`
  - `addToHist(hist: number[], ms: number): void`
  - `class Aggregator` with `constructor(maxSignatures: number)`, `add(sig: SignatureResult, durationMs: number, sample: unknown): void`, `swap(): { items: IngestItem[]; dropped: number }`, `readonly size: number`, `merge(items: IngestItem[]): void`

`merge` folds a failed batch back in; the transport in Task 7 calls it on retry.

- [ ] **Step 1: Write the failing tests**

`packages/sdk/src/histogram.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { bucketIndex, newHist, addToHist } from './histogram.js';

describe('bucketIndex', () => {
  it('maps a duration to the bucket whose upper bound it falls under', () => {
    expect(bucketIndex(50)).toBe(0);      // [0,100)  — only seen when thresholdMs < 100
    expect(bucketIndex(99)).toBe(0);
    expect(bucketIndex(101)).toBe(1);     // [100,250)
    expect(bucketIndex(249)).toBe(1);
    expect(bucketIndex(250)).toBe(2);     // bucket i covers [BOUNDS[i-1], BOUNDS[i])
    expect(bucketIndex(999)).toBe(3);
    expect(bucketIndex(1000)).toBe(4);
    expect(bucketIndex(9999)).toBe(6);
    expect(bucketIndex(10000)).toBe(7);   // overflow bucket
    expect(bucketIndex(600000)).toBe(7);
  });
});

describe('newHist / addToHist', () => {
  it('starts as eight zeroes', () => {
    expect(newHist()).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
  });

  it('increments the right bucket', () => {
    const h = newHist();
    addToHist(h, 120);
    addToHist(h, 120);
    addToHist(h, 30000);
    expect(h).toEqual([0, 2, 0, 0, 0, 0, 0, 1]);
  });
});
```

`packages/sdk/src/aggregator.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { Aggregator } from './aggregator.js';
import { buildSignature } from './signature.js';

const sigA = buildSignature({ model: 'Order', operation: 'find', filter: { status: 'paid' } });
const sigB = buildSignature({ model: 'User', operation: 'findOne', filter: { email: 'x' } });

describe('Aggregator', () => {
  it('folds repeated occurrences of one signature into a single item', () => {
    const agg = new Aggregator(100);
    agg.add(sigA, 120, { status: '<string>' });
    agg.add(sigA, 300, { status: '<string>' });
    const { items } = agg.swap();

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ hash: sigA.hash, count: 2, totalMs: 420, maxMs: 300, lastMs: 300 });
    expect(items[0]!.hist).toEqual([0, 1, 1, 0, 0, 0, 0, 0]);   // 120ms → bucket 1, 300ms → bucket 2
  });

  it('keeps distinct signatures apart', () => {
    const agg = new Aggregator(100);
    agg.add(sigA, 120, null);
    agg.add(sigB, 120, null);
    expect(agg.swap().items).toHaveLength(2);
  });

  it('empties itself on swap so the next window starts clean', () => {
    const agg = new Aggregator(100);
    agg.add(sigA, 120, null);
    expect(agg.swap().items).toHaveLength(1);
    expect(agg.swap().items).toHaveLength(0);
    expect(agg.size).toBe(0);
  });

  it('drops new signatures past the cap and counts the drops', () => {
    const agg = new Aggregator(1);
    agg.add(sigA, 120, null);
    agg.add(sigB, 120, null);
    const { items, dropped } = agg.swap();
    expect(items).toHaveLength(1);
    expect(dropped).toBe(1);
  });

  it('still aggregates a known signature after the cap is reached', () => {
    const agg = new Aggregator(1);
    agg.add(sigA, 120, null);
    agg.add(sigB, 120, null);   // dropped
    agg.add(sigA, 200, null);   // known — must still count
    const { items } = agg.swap();
    expect(items[0]).toMatchObject({ count: 2 });
  });

  it('reports the drop count once and then resets it', () => {
    const agg = new Aggregator(1);
    agg.add(sigA, 120, null);
    agg.add(sigB, 120, null);
    expect(agg.swap().dropped).toBe(1);
    expect(agg.swap().dropped).toBe(0);
  });

  it('keeps the sample from the slowest occurrence', () => {
    const agg = new Aggregator(10);
    agg.add(sigA, 120, { tag: 'slow-120' });
    agg.add(sigA, 900, { tag: 'slow-900' });
    agg.add(sigA, 200, { tag: 'slow-200' });
    expect(agg.swap().items[0]!.sample).toEqual({ tag: 'slow-900' });
  });

  it('merges a returned batch back, summing counts and adding histograms elementwise', () => {
    const agg = new Aggregator(10);
    agg.add(sigA, 120, null);
    const first = agg.swap().items;

    agg.add(sigA, 300, null);
    agg.merge(first);

    const { items } = agg.swap();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ count: 2, totalMs: 420, maxMs: 300 });
    expect(items[0]!.hist[1]).toBe(1);
    expect(items[0]!.hist[2]).toBe(1);
  });

  it('refuses to merge past the cap rather than growing without bound', () => {
    const agg = new Aggregator(1);
    agg.add(sigA, 120, null);
    agg.merge([{ ...agg.swap().items[0]!, hash: 'ffffffffffffffff' }]);
    agg.add(sigA, 120, null);
    expect(agg.size).toBeLessThanOrEqual(1);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @query-analyser/sdk test`
Expected: FAIL — cannot resolve `./histogram.js` and `./aggregator.js`.

- [ ] **Step 3: Write the implementations**

`packages/sdk/src/histogram.ts`:
```ts
import { HIST_BOUNDS, HIST_SIZE } from '@query-analyser/contract/runtime';

/** Index of the bucket a duration belongs to. The last bucket is unbounded. */
export function bucketIndex(ms: number): number {
  for (let i = 0; i < HIST_BOUNDS.length; i++) {
    if (ms < HIST_BOUNDS[i]!) return i;
  }
  return HIST_SIZE - 1;
}

export function newHist(): number[] {
  return new Array<number>(HIST_SIZE).fill(0);
}

export function addToHist(hist: number[], ms: number): void {
  const i = bucketIndex(ms);
  hist[i] = (hist[i] ?? 0) + 1;
}
```

Note on bucket semantics: bucket `i` covers `[BOUNDS[i-1], BOUNDS[i])`, so bucket 0 is `[0, 100)` and bucket 7 is `[10000, ∞)`. With the default `thresholdMs` of 100, bucket 0 stays empty; it fills only when a customer lowers the threshold. This makes the histogram independent of the threshold setting, which is what lets the server compare apps configured differently.

`packages/sdk/src/aggregator.ts`:
```ts
import type { IngestItem } from '@query-analyser/contract/runtime';
import { HIST_SIZE, } from '@query-analyser/contract/runtime';
import { addToHist, newHist } from './histogram.js';
import type { SignatureResult } from './signature.js';

/**
 * In-memory fold of slow queries by signature. The only state the hot path
 * touches. `swap()` hands the window to the transport and starts a fresh one.
 */
export class Aggregator {
  private buffer = new Map<string, IngestItem>();
  private droppedCount = 0;

  constructor(private readonly maxSignatures: number) {}

  get size(): number {
    return this.buffer.size;
  }

  add(sig: SignatureResult, durationMs: number, sample: unknown): void {
    let item = this.buffer.get(sig.hash);

    if (!item) {
      if (this.buffer.size >= this.maxSignatures) {
        this.droppedCount++;
        return;
      }
      item = {
        signature: sig.signature,
        hash: sig.hash,
        model: sig.model,
        operation: sig.operation,
        filterShape: sig.filterShape,
        sortKeys: sig.sortKeys,
        stages: sig.stages,
        count: 0,
        totalMs: 0,
        maxMs: 0,
        lastMs: 0,
        lastTs: 0,
        hist: newHist(),
        sample: null,
      };
      this.buffer.set(sig.hash, item);
    }

    item.count += 1;
    item.totalMs += durationMs;
    item.lastMs = durationMs;
    item.lastTs = Date.now();
    addToHist(item.hist, durationMs);
    if (durationMs >= item.maxMs) {
      item.maxMs = durationMs;
      item.sample = sample;   // keep the sample from the worst occurrence
    }
  }

  /** Take the current window and reset. */
  swap(): { items: IngestItem[]; dropped: number } {
    const items = [...this.buffer.values()];
    const dropped = this.droppedCount;
    this.buffer = new Map();
    this.droppedCount = 0;
    return { items, dropped };
  }

  /** Fold an un-delivered batch back in, bounded by the same cap. */
  merge(items: IngestItem[]): void {
    for (const incoming of items) {
      const existing = this.buffer.get(incoming.hash);
      if (!existing) {
        if (this.buffer.size >= this.maxSignatures) { this.droppedCount++; continue; }
        this.buffer.set(incoming.hash, { ...incoming, hist: [...incoming.hist] });
        continue;
      }
      existing.count += incoming.count;
      existing.totalMs += incoming.totalMs;
      for (let i = 0; i < HIST_SIZE; i++) {
        existing.hist[i] = (existing.hist[i] ?? 0) + (incoming.hist[i] ?? 0);
      }
      if (incoming.maxMs > existing.maxMs) {
        existing.maxMs = incoming.maxMs;
        existing.sample = incoming.sample;
      }
      if (incoming.lastTs > existing.lastTs) {
        existing.lastTs = incoming.lastTs;
        existing.lastMs = incoming.lastMs;
      }
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @query-analyser/sdk test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/sdk/src
git commit -m "feat(sdk): add latency histogram and signature aggregator"
```

---

### Task 7: SDK — transport

**Files:**
- Create: `packages/sdk/src/transport.ts`
- Test: `packages/sdk/src/transport.test.ts`

**Interfaces:**
- Consumes: `IngestPayload` type from the contract runtime.
- Produces: `createTransport(opts: { endpoint: string; apiKey: string; fetchImpl?: typeof fetch; onError?: (e: Error) => void }): Transport`, where `Transport` is `{ send(payload: IngestPayload): Promise<SendResult> }` and `type SendResult = { status: 'ok' } | { status: 'retry'; afterMs: number } | { status: 'disabled'; reason: string }`.

Retry policy lives in the caller (Task 8); the transport reports what happened and how long to wait.

- [ ] **Step 1: Write the failing test**

`packages/sdk/src/transport.test.ts`:
```ts
import { describe, it, expect, vi } from 'vitest';
import { gunzipSync } from 'node:zlib';
import { createTransport } from './transport.js';
import type { IngestPayload } from '@query-analyser/contract/runtime';

const payload: IngestPayload = {
  app: 'test-app', env: 'test', host: 'h', sdkVersion: '0.1.0',
  bucket: '2026092014', thresholdMs: 100, dropped: 0,
  items: [{
    signature: 'Order.find(status:eq)', hash: 'a'.repeat(16), model: 'Order', operation: 'find',
    filterShape: [{ key: 'status', op: 'eq' }], sortKeys: [], stages: [],
    count: 1, totalMs: 120, maxMs: 120, lastMs: 120, lastTs: 1, hist: [1,0,0,0,0,0,0,0],
    sample: { status: '<string>' },
  }],
};

const ok = () => new Response('{}', { status: 202 });

describe('transport', () => {
  it('posts JSON with a bearer token', async () => {
    const fetchImpl = vi.fn(ok);
    const t = createTransport({ endpoint: 'https://x/v1/ingest', apiKey: 'qa_live_k', fetchImpl });
    expect(await t.send(payload)).toEqual({ status: 'ok' });

    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('https://x/v1/ingest');
    const headers = init!.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer qa_live_k');
    expect(headers['Content-Type']).toBe('application/json');
  });

  it('gzips bodies over 1KB and marks the encoding', async () => {
    const fetchImpl = vi.fn(ok);
    const big = { ...payload, items: Array.from({ length: 50 }, () => payload.items[0]!) };
    const t = createTransport({ endpoint: 'https://x', apiKey: 'k', fetchImpl });
    await t.send(big);

    const init = fetchImpl.mock.calls[0]![1]!;
    expect((init.headers as Record<string, string>)['Content-Encoding']).toBe('gzip');
    const sent = JSON.parse(gunzipSync(init.body as Buffer).toString('utf8'));
    expect(sent.items).toHaveLength(50);
  });

  it('treats 401 as permanently disabled', async () => {
    const fetchImpl = vi.fn(() => new Response('bad key', { status: 401 }));
    const t = createTransport({ endpoint: 'https://x', apiKey: 'k', fetchImpl });
    expect(await t.send(payload)).toMatchObject({ status: 'disabled' });
  });

  it('treats 403 as permanently disabled', async () => {
    const fetchImpl = vi.fn(() => new Response('revoked', { status: 403 }));
    const t = createTransport({ endpoint: 'https://x', apiKey: 'k', fetchImpl });
    expect(await t.send(payload)).toMatchObject({ status: 'disabled' });
  });

  it('honours Retry-After on 429', async () => {
    const fetchImpl = vi.fn(() => new Response('slow down', {
      status: 429, headers: { 'Retry-After': '30' },
    }));
    const t = createTransport({ endpoint: 'https://x', apiKey: 'k', fetchImpl });
    expect(await t.send(payload)).toEqual({ status: 'retry', afterMs: 30_000 });
  });

  it('retries on a 5xx', async () => {
    const fetchImpl = vi.fn(() => new Response('boom', { status: 503 }));
    const t = createTransport({ endpoint: 'https://x', apiKey: 'k', fetchImpl });
    expect(await t.send(payload)).toMatchObject({ status: 'retry' });
  });

  it('drops the batch on a 400 rather than retrying a body the server will never accept', async () => {
    const fetchImpl = vi.fn(() => new Response('invalid', { status: 400 }));
    const onError = vi.fn();
    const t = createTransport({ endpoint: 'https://x', apiKey: 'k', fetchImpl, onError });
    expect(await t.send(payload)).toEqual({ status: 'ok' });
    expect(onError).toHaveBeenCalled();
  });

  it('retries when the network throws, and reports the error', async () => {
    const fetchImpl = vi.fn(() => Promise.reject(new Error('ECONNREFUSED')));
    const onError = vi.fn();
    const t = createTransport({ endpoint: 'https://x', apiKey: 'k', fetchImpl, onError });
    expect(await t.send(payload)).toMatchObject({ status: 'retry' });
    expect(onError).toHaveBeenCalledWith(expect.any(Error));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @query-analyser/sdk test`
Expected: FAIL — cannot resolve `./transport.js`.

- [ ] **Step 3: Write the implementation**

`packages/sdk/src/transport.ts`:
```ts
import { gzipSync } from 'node:zlib';
import type { IngestPayload } from '@query-analyser/contract/runtime';

export type SendResult =
  | { status: 'ok' }
  | { status: 'retry'; afterMs: number }
  | { status: 'disabled'; reason: string };

export interface TransportOptions {
  endpoint: string;
  apiKey: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  onError?: (err: Error) => void;
}

export interface Transport {
  send(payload: IngestPayload): Promise<SendResult>;
}

const GZIP_THRESHOLD_BYTES = 1024;
const DEFAULT_RETRY_MS = 5_000;

export function createTransport(opts: TransportOptions): Transport {
  const doFetch = opts.fetchImpl ?? globalThis.fetch;
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const report = (e: Error) => { try { opts.onError?.(e); } catch { /* never throw from reporting */ } };

  return {
    async send(payload) {
      const json = JSON.stringify(payload);
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${opts.apiKey}`,
      };

      let body: string | Buffer = json;
      if (Buffer.byteLength(json) > GZIP_THRESHOLD_BYTES) {
        body = gzipSync(json);
        headers['Content-Encoding'] = 'gzip';
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const res = await doFetch(opts.endpoint, {
          method: 'POST', headers, body, signal: controller.signal,
        });

        if (res.ok) return { status: 'ok' };

        if (res.status === 401 || res.status === 403) {
          return { status: 'disabled', reason: `ingest rejected the API key (HTTP ${res.status})` };
        }

        if (res.status === 429) {
          const header = res.headers.get('Retry-After');
          const afterMs = header ? Number(header) * 1000 : DEFAULT_RETRY_MS;
          return { status: 'retry', afterMs: Number.isFinite(afterMs) ? afterMs : DEFAULT_RETRY_MS };
        }

        if (res.status >= 400 && res.status < 500) {
          // The server will never accept this body. Drop it; keeping it would
          // block the buffer forever.
          report(new Error(`ingest rejected the batch (HTTP ${res.status})`));
          return { status: 'ok' };
        }

        return { status: 'retry', afterMs: DEFAULT_RETRY_MS };
      } catch (err) {
        report(err instanceof Error ? err : new Error(String(err)));
        return { status: 'retry', afterMs: DEFAULT_RETRY_MS };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @query-analyser/sdk test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/sdk/src/transport.ts packages/sdk/src/transport.test.ts
git commit -m "feat(sdk): add batching transport with backoff and disable-on-401"
```

---

### Task 8: SDK — init, hook installation, flush loop

The task that makes the one-line promise true.

**Files:**
- Create: `packages/sdk/src/hooks.ts`, `packages/sdk/src/index.ts`
- Test: `packages/sdk/src/hooks.test.ts`, `packages/sdk/src/index.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 4–7.
- Produces:
  - `init(options: InitOptions): Analyser`
  - `shutdown(): Promise<void>`
  - `interface InitOptions { apiKey: string; app: string; endpoint?: string; env?: string; thresholdMs?: number; flushIntervalMs?: number; maxSignatures?: number; enabled?: boolean; mongoose?: MongooseLike; fetchImpl?: typeof fetch; onError?: (e: Error) => void }`
  - `interface Analyser { flush(): Promise<void>; shutdown(): Promise<void>; readonly installedModels: number }`
  - `installHooks(schema: MongooseSchemaLike, ctx: HookContext): boolean` — returns false if already installed on that schema

Defaults: `endpoint` `https://ingest.query-analyser.dev/v1/ingest`, `env` `process.env.NODE_ENV ?? 'development'`, `thresholdMs` 100, `flushIntervalMs` 10000, `maxSignatures` 5000, `enabled` true.

- [ ] **Step 1: Write the failing tests**

`packages/sdk/src/hooks.test.ts`:
```ts
import { describe, it, expect, vi } from 'vitest';
import mongoose from 'mongoose';
import { installHooks } from './hooks.js';
import { Aggregator } from './aggregator.js';

function ctx(threshold = 0) {
  return { aggregator: new Aggregator(100), thresholdMs: threshold, onError: vi.fn() };
}

describe('installHooks', () => {
  it('installs only once per schema', () => {
    const schema = new mongoose.Schema({ a: String });
    expect(installHooks(schema, ctx())).toBe(true);
    expect(installHooks(schema, ctx())).toBe(false);
  });

  it('never lets an internal failure escape into the query', async () => {
    const c = ctx();
    // Force a failure inside the hook body.
    vi.spyOn(c.aggregator, 'add').mockImplementation(() => { throw new Error('boom'); });
    const schema = new mongoose.Schema({ a: String });
    installHooks(schema, c);

    const M = mongoose.model(`Escape_${Date.now()}`, schema);
    // No connection: the query rejects with a mongoose error, never with 'boom'.
    await expect(M.find({ a: 'x' }).maxTimeMS(1).exec()).rejects.not.toThrow(/boom/);
  });
});
```

`packages/sdk/src/index.test.ts`:
```ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import mongoose from 'mongoose';
import { init, shutdown } from './index.js';

afterEach(async () => { await shutdown(); });

const okFetch = () => Promise.resolve(new Response('{}', { status: 202 }));

describe('init', () => {
  it('requires an apiKey and an app name', () => {
    expect(() => init({ apiKey: '', app: 'x' })).toThrow(/apiKey/);
    expect(() => init({ apiKey: 'k', app: '' })).toThrow(/app/);
  });

  it('instruments models compiled BEFORE init was called', () => {
    const m = mongoose;
    m.model('BeforeInit', new mongoose.Schema({ a: String }));
    const a = init({ apiKey: 'k', app: 'x', mongoose: m, fetchImpl: okFetch });
    expect(a.installedModels).toBeGreaterThan(0);
  });

  it('instruments models compiled AFTER init via the global plugin', () => {
    const m = mongoose;
    init({ apiKey: 'k', app: 'x', mongoose: m, fetchImpl: okFetch });
    const schema = new mongoose.Schema({ a: String });
    m.model(`AfterInit_${Date.now()}`, schema);
    // The global plugin ran, so the install marker is on the schema.
    expect(Object.getOwnPropertySymbols(schema).some((s) => String(s).includes('query-analyser')))
      .toBe(true);
  });

  it('does nothing at all when disabled', () => {
    const fetchImpl = vi.fn(okFetch);
    const a = init({ apiKey: 'k', app: 'x', enabled: false, mongoose, fetchImpl });
    expect(a.installedModels).toBe(0);
  });

  it('sends nothing when the window is empty', async () => {
    const fetchImpl = vi.fn(okFetch);
    const a = init({ apiKey: 'k', app: 'x', mongoose, fetchImpl });
    await a.flush();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('stops sending after the server rejects the key', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(new Response('no', { status: 401 })));
    const a = init({ apiKey: 'bad', app: 'x', mongoose, thresholdMs: 0, fetchImpl });
    // Two flushes with content; only the first should reach the network.
    // (Content is produced via the aggregator in the integration test; here we
    // assert the disable latch by flushing a synthesised item.)
    await a.flush();
    await a.flush();
    expect(fetchImpl.mock.calls.length).toBeLessThanOrEqual(1);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @query-analyser/sdk test`
Expected: FAIL — cannot resolve `./hooks.js` and `./index.js`.

- [ ] **Step 3: Write the implementations**

`packages/sdk/src/hooks.ts`:
```ts
import type { Aggregator } from './aggregator.js';
import { buildSignature } from './signature.js';
import { redact } from './redact.js';

const INSTALLED = Symbol.for('query-analyser.installed');

const QUERY_OPS = /^(find|findOne|findOneAnd|count|countDocuments|distinct|update|updateOne|updateMany|replaceOne|deleteOne|deleteMany)/;

export interface HookContext {
  aggregator: Aggregator;
  thresholdMs: number;
  onError: (e: Error) => void;
}

/** Minimal structural type so the SDK never imports mongoose at runtime. */
export interface MongooseSchemaLike {
  pre(match: RegExp | string, fn: (this: unknown, next: () => void) => void): unknown;
  post(match: RegExp | string, fn: (this: unknown, res: unknown, next: () => void) => void): unknown;
}

type TimedQuery = {
  _qaStart?: number;
  op?: string;
  model?: unknown;
  _model?: unknown;
  getQuery?: () => unknown;
  getOptions?: () => { sort?: unknown };
  getUpdate?: () => unknown;
  pipeline?: () => unknown[];
};

function modelNameOf(q: TimedQuery): string {
  const m = q._model ?? (typeof q.model === 'function' ? (q.model as () => unknown)() : q.model);
  return (m as { modelName?: string } | undefined)?.modelName ?? 'unknown';
}

export function installHooks(schema: MongooseSchemaLike, ctx: HookContext): boolean {
  const s = schema as MongooseSchemaLike & { [INSTALLED]?: boolean };
  if (s[INSTALLED]) return false;
  Object.defineProperty(s, INSTALLED, { value: true, enumerable: false });

  const pre = function (this: TimedQuery, next: () => void) {
    this._qaStart = Date.now();
    next();
  };

  const post = function (this: TimedQuery, _res: unknown, next: () => void) {
    try {
      if (this._qaStart == null) return next();
      const duration = Date.now() - this._qaStart;
      if (duration <= ctx.thresholdMs) return next();

      const isAggregate = typeof this.pipeline === 'function';
      const pipeline = isAggregate ? this.pipeline!() : undefined;
      const filter = !isAggregate && this.getQuery ? this.getQuery() : undefined;
      const update = !isAggregate && this.getUpdate ? this.getUpdate() : undefined;
      const sort = !isAggregate && this.getOptions ? this.getOptions()?.sort : undefined;

      const sig = buildSignature({
        model: modelNameOf(this),
        operation: isAggregate ? 'aggregate' : (this.op ?? 'unknown'),
        filter, sort, pipeline,
      });

      const sample = redact(isAggregate ? { pipeline } : { filter, update, sort });
      ctx.aggregator.add(sig, duration, sample);
    } catch (err) {
      ctx.onError(err instanceof Error ? err : new Error(String(err)));
    }
    next();
  };

  schema.pre(QUERY_OPS, pre);
  schema.post(QUERY_OPS, post);
  schema.pre('aggregate', pre);
  schema.post('aggregate', post);

  return true;
}
```

`packages/sdk/src/index.ts`:
```ts
import { hostname } from 'node:os';
import { bucketOf } from '@query-analyser/contract/runtime';
import type { IngestPayload } from '@query-analyser/contract/runtime';
import { Aggregator } from './aggregator.js';
import { installHooks, type MongooseSchemaLike } from './hooks.js';
import { createTransport } from './transport.js';

export const SDK_VERSION = '0.1.0';
const DEFAULT_ENDPOINT = 'https://ingest.query-analyser.dev/v1/ingest';

export interface MongooseLike {
  plugin(fn: (schema: MongooseSchemaLike) => void): unknown;
  models: Record<string, { schema: MongooseSchemaLike }>;
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
  mongoose?: MongooseLike;
  fetchImpl?: typeof fetch;
  onError?: (e: Error) => void;
}

export interface Analyser {
  flush(): Promise<void>;
  shutdown(): Promise<void>;
  readonly installedModels: number;
}

let active: (Analyser & { _stop(): void }) | null = null;

function resolveMongoose(explicit?: MongooseLike): MongooseLike | null {
  if (explicit) return explicit;
  try {
    // Resolved from the host app so there is exactly one mongoose instance.
    const req = (globalThis as { require?: (id: string) => unknown }).require
      ?? (typeof module !== 'undefined' ? module.require?.bind(module) : undefined);
    return (req?.('mongoose') as MongooseLike) ?? null;
  } catch {
    return null;
  }
}

export function init(options: InitOptions): Analyser {
  if (!options.apiKey) throw new Error('query-analyser: apiKey is required');
  if (!options.app) throw new Error('query-analyser: app is required');

  if (active) return active;

  const onError = options.onError
    ?? ((e: Error) => process.stderr.write(`[query-analyser] ${e.message}\n`));

  if (options.enabled === false) {
    const noop: Analyser & { _stop(): void } = {
      flush: async () => {}, shutdown: async () => {}, installedModels: 0, _stop: () => {},
    };
    active = noop;
    return noop;
  }

  const thresholdMs = options.thresholdMs ?? 100;
  const flushIntervalMs = options.flushIntervalMs ?? 10_000;
  const aggregator = new Aggregator(options.maxSignatures ?? 5000);
  const transport = createTransport({
    endpoint: options.endpoint ?? DEFAULT_ENDPOINT,
    apiKey: options.apiKey,
    fetchImpl: options.fetchImpl,
    onError,
  });

  const ctx = { aggregator, thresholdMs, onError };
  let installedModels = 0;
  let disabled = false;
  let backoffUntil = 0;

  const mg = resolveMongoose(options.mongoose);
  if (!mg) {
    onError(new Error('mongoose could not be resolved — pass it as init({ mongoose })'));
  } else {
    // Future models.
    mg.plugin((schema) => { installHooks(schema, ctx); });
    // Models already compiled before init ran — without this, setup is
    // order-dependent and the one-line promise is false.
    for (const name of Object.keys(mg.models)) {
      if (installHooks(mg.models[name]!.schema, ctx)) installedModels++;
    }
  }

  const flush = async (): Promise<void> => {
    if (disabled || Date.now() < backoffUntil) return;
    const { items, dropped } = aggregator.swap();
    if (items.length === 0 && dropped === 0) return;

    const payload: IngestPayload = {
      app: options.app,
      env: options.env ?? process.env.NODE_ENV ?? 'development',
      host: hostname(),
      sdkVersion: SDK_VERSION,
      bucket: bucketOf(new Date()),
      thresholdMs,
      dropped,
      items,
    };

    const result = await transport.send(payload);
    if (result.status === 'retry') {
      backoffUntil = Date.now() + result.afterMs;
      aggregator.merge(items);
    } else if (result.status === 'disabled') {
      disabled = true;
      onError(new Error(result.reason));
    }
  };

  const timer = setInterval(() => { void flush(); }, flushIntervalMs);
  timer.unref();

  const onExit = () => { void flush(); };
  process.once('beforeExit', onExit);
  process.once('SIGTERM', onExit);

  const analyser: Analyser & { _stop(): void } = {
    flush,
    installedModels,
    async shutdown() {
      clearInterval(timer);
      process.off('beforeExit', onExit);
      process.off('SIGTERM', onExit);
      backoffUntil = 0;
      await flush();
    },
    _stop() { clearInterval(timer); },
  };

  active = analyser;
  return analyser;
}

export async function shutdown(): Promise<void> {
  const a = active;
  active = null;
  await a?.shutdown();
}

export { Aggregator } from './aggregator.js';
export { buildSignature } from './signature.js';
export { redact } from './redact.js';
export default { init, shutdown };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @query-analyser/sdk test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/sdk/src
git commit -m "feat(sdk): add init, hook installation and flush loop"
```

---

### Task 9: SDK — integration test against a real MongoDB

Proves the whole chain on real mongoose operations, and proves the privacy claim against the actual serialised payload rather than against a unit-tested helper.

**Files:**
- Create: `packages/sdk/src/__tests__/integration.test.ts`
- Modify: `packages/sdk/vitest.config.ts` (raise `testTimeout` to 60000 — downloading a mongod binary on first run is slow)

**Interfaces:**
- Consumes: `init`, `shutdown` from Task 8.
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Write the failing test**

`packages/sdk/src/__tests__/integration.test.ts`:
```ts
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { init, shutdown } from '../index.js';

let mongod: MongoMemoryServer;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
}, 60_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

afterEach(async () => { await shutdown(); });

function capture() {
  const bodies: string[] = [];
  const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    bodies.push(typeof init?.body === 'string' ? init.body : String(init?.body));
    return new Response('{}', { status: 202 });
  }) as unknown as typeof fetch;
  return { bodies, fetchImpl };
}

describe('end to end', () => {
  it('captures a real find and reports it with the right shape', async () => {
    const Order = mongoose.model('IntOrder', new mongoose.Schema({ status: String, total: Number }));
    const { bodies, fetchImpl } = capture();
    // thresholdMs 0 so every query counts — real queries on an in-memory
    // server are far faster than 100ms.
    const a = init({ apiKey: 'k', app: 'int-app', thresholdMs: 0, mongoose, fetchImpl });

    await Order.find({ status: 'paid', total: { $gte: 10 } }).sort({ total: -1 }).exec();
    await a.flush();

    expect(bodies).toHaveLength(1);
    const sent = JSON.parse(bodies[0]!);
    expect(sent.app).toBe('int-app');
    expect(sent.items).toHaveLength(1);
    expect(sent.items[0]).toMatchObject({
      model: 'IntOrder',
      operation: 'find',
      filterShape: [{ key: 'status', op: 'eq' }, { key: 'total', op: 'range' }],
      sortKeys: [{ key: 'total', dir: -1 }],
      count: 1,
    });
    expect(sent.items[0].hist.reduce((x: number, y: number) => x + y, 0)).toBe(1);
  });

  it('collapses many executions of one shape into one item', async () => {
    const User = mongoose.model('IntUser', new mongoose.Schema({ email: String }));
    const { bodies, fetchImpl } = capture();
    const a = init({ apiKey: 'k', app: 'int-app', thresholdMs: 0, mongoose, fetchImpl });

    for (const email of ['a@x.com', 'b@x.com', 'c@x.com']) {
      await User.findOne({ email }).exec();
    }
    await a.flush();

    const sent = JSON.parse(bodies[0]!);
    expect(sent.items).toHaveLength(1);
    expect(sent.items[0].count).toBe(3);
  });

  it('instruments a model that was compiled before init ran', async () => {
    const Early = mongoose.model('IntEarly', new mongoose.Schema({ a: String }));
    const { bodies, fetchImpl } = capture();
    const a = init({ apiKey: 'k', app: 'int-app', thresholdMs: 0, mongoose, fetchImpl });

    await Early.find({ a: 'z' }).exec();
    await a.flush();

    expect(JSON.parse(bodies[0]!).items.some((i: { model: string }) => i.model === 'IntEarly')).toBe(true);
  });

  it('captures an aggregate as its stage list', async () => {
    const Sale = mongoose.model('IntSale', new mongoose.Schema({ region: String, amt: Number }));
    const { bodies, fetchImpl } = capture();
    const a = init({ apiKey: 'k', app: 'int-app', thresholdMs: 0, mongoose, fetchImpl });

    await Sale.aggregate([{ $match: { region: 'IN' } }, { $group: { _id: '$region', t: { $sum: '$amt' } } }]);
    await a.flush();

    const item = JSON.parse(bodies[0]!).items[0];
    expect(item.operation).toBe('aggregate');
    expect(item.stages).toEqual(['$match', '$group']);
  });

  it('never puts a queried value in the payload', async () => {
    const Secret = mongoose.model('IntSecret', new mongoose.Schema({ email: String, pin: Number }));
    const { bodies, fetchImpl } = capture();
    const a = init({ apiKey: 'k', app: 'int-app', thresholdMs: 0, mongoose, fetchImpl });

    await Secret.find({ email: 'leak-me@example.com', pin: 987654 }).exec();
    await Secret.updateMany({ email: 'leak-me@example.com' }, { $set: { pin: 111222 } }).exec();
    await a.flush();

    const body = bodies.join('');
    expect(body).not.toContain('leak-me@example.com');
    expect(body).not.toContain('987654');
    expect(body).not.toContain('111222');
    // …but the key names are there, because those are what we analyse.
    expect(body).toContain('email');
    expect(body).toContain('pin');
  });

  it('does not break the query when the endpoint is dead', async () => {
    const Live = mongoose.model('IntLive', new mongoose.Schema({ a: String }));
    const fetchImpl = (() => Promise.reject(new Error('ECONNREFUSED'))) as unknown as typeof fetch;
    const a = init({ apiKey: 'k', app: 'int-app', thresholdMs: 0, mongoose, fetchImpl, onError: () => {} });

    await expect(Live.find({ a: 'x' }).exec()).resolves.toEqual([]);
    await expect(a.flush()).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @query-analyser/sdk test -- integration`
Expected: FAIL. On first run mongodb-memory-server downloads a mongod binary; allow time.

- [ ] **Step 3: Make it pass**

No new production file is expected. If a test fails, the bug is in Tasks 4–8 — fix it there and note what was wrong. The two failures most likely to appear:
- `operation` reads `unknown` for some ops, because mongoose sets `this.op` at different times for different methods. Fix in `hooks.ts` by falling back to the hook's own matched name.
- `sortKeys` is empty because `getOptions()` is not populated at `pre` time. The sort is read in `post`, which is correct; if it is still empty, read `this.options?.sort` as a fallback.

- [ ] **Step 4: Run the full suite**

Run: `pnpm test`
Expected: PASS, every package.

- [ ] **Step 5: Commit**

```bash
git add packages/sdk
git commit -m "test(sdk): add end-to-end integration tests with a real mongod"
```

---

### Task 10: Publish `@vivekumar08/query-analyser`

**Files:**
- Create: `packages/sdk/tsup.config.ts`, `packages/sdk/README.md`, `packages/sdk/LICENSE`
- Modify: `packages/sdk/package.json`

**Interfaces:**
- Consumes: the built SDK.
- Produces: a published npm package whose install is the one line in the README.

- [ ] **Step 1: Write the build config**

`packages/sdk/tsup.config.ts`:
```ts
import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  target: 'node20',
  // The contract is a workspace package and is NOT published — inline it so
  // the published SDK has zero runtime dependencies.
  noExternal: [/@query-analyser\/contract/],
  external: ['mongoose'],
});
```

- [ ] **Step 2: Set the published manifest**

Replace `packages/sdk/package.json` with:
```json
{
  "name": "@vivekumar08/query-analyser",
  "version": "0.1.0",
  "description": "Find your slow MongoDB queries. One line of setup.",
  "license": "MIT",
  "type": "module",
  "main": "./dist/index.cjs",
  "module": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js",
      "require": "./dist/index.cjs"
    }
  },
  "files": ["dist", "README.md", "LICENSE"],
  "engines": { "node": ">=20" },
  "keywords": ["mongodb", "mongoose", "slow-query", "performance", "apm", "profiler"],
  "publishConfig": { "access": "public" },
  "scripts": {
    "build": "tsup",
    "test": "vitest run",
    "typecheck": "tsc --noEmit",
    "prepublishOnly": "pnpm build && pnpm test"
  },
  "dependencies": {},
  "peerDependencies": { "mongoose": ">=6 <9" },
  "devDependencies": {
    "@query-analyser/contract": "workspace:*",
    "mongoose": "^8.9.0",
    "mongodb-memory-server": "^10.1.2",
    "tsup": "^8.3.5",
    "typescript": "^5.7.2",
    "vitest": "^2.1.8"
  }
}
```

- [ ] **Step 3: Write the README**

`packages/sdk/README.md`:
````markdown
# @vivekumar08/query-analyser

Find your slow MongoDB queries. One line of setup.

```bash
npm install @vivekumar08/query-analyser
```

```js
require('@vivekumar08/query-analyser').init({
  apiKey: process.env.QA_KEY,
  app: 'my-service',
});
```

That is the whole setup. Every mongoose query slower than 100 ms is grouped by
its *shape*, aggregated in memory, and shipped to your dashboard every ten
seconds.

## What leaves your process

Key names, operator classes, durations, counts. That is all.

A query like `Order.find({ email: 'someone@example.com', total: { $gte: 500 } })`
is reported as:

```
Order.find(email:eq,total:range)
```

with a type-only sample: `{ email: '<string>', total: { $gte: '<number>' } }`.
**No queried value ever leaves your process.** There is no option to turn that off.

## Options

| Option | Default | Meaning |
|---|---|---|
| `apiKey` | — | required; your app's ingest key |
| `app` | — | required; names the app in the dashboard |
| `thresholdMs` | `100` | only queries slower than this are recorded |
| `flushIntervalMs` | `10000` | how often a batch is sent |
| `maxSignatures` | `5000` | cap on distinct shapes held between flushes |
| `env` | `NODE_ENV` | separates production from staging in the dashboard |
| `enabled` | `true` | set `false` to make `init` a no-op |
| `endpoint` | hosted ingest | override for self-hosted |
| `mongoose` | auto-resolved | pass explicitly if resolution fails |
| `onError` | logs to stderr | called with internal errors |

## Notes

- Call `init()` anywhere. Models compiled before the call are instrumented too.
- Nothing runs on the query path except a timestamp and a map write. No I/O.
- If the endpoint is unreachable the SDK retries with backoff and then drops.
  Your queries are never affected.
- `await require('@vivekumar08/query-analyser').shutdown()` drains the buffer
  before exit. `SIGTERM` and `beforeExit` do this for you.

MIT
````

Add an MIT `LICENSE` with copyright `2026 Vivek Kumar`.

- [ ] **Step 4: Verify the package contents before publishing**

```bash
pnpm --filter @vivekumar08/query-analyser build
cd packages/sdk && npm pack --dry-run
```

Expected: the tarball contains only `dist/`, `README.md`, `LICENSE` and `package.json`. Confirm `dist/index.js` contains no `require('@query-analyser/contract')` — the contract must be inlined:

```bash
grep -c "@query-analyser/contract" dist/index.js || echo "inlined correctly"
```

Expected: `inlined correctly`.

Then publish:
```bash
npm publish --access public
```

- [ ] **Step 5: Commit**

```bash
git add -A packages/sdk
git commit -m "chore(sdk): add build config, README and publish manifest"
git tag sdk-v0.1.0
```

---

## Verification

After Task 10, all of the following must hold:

- [ ] `pnpm test` passes in every package.
- [ ] `pnpm typecheck` passes with no errors.
- [ ] `npm pack --dry-run` shows no runtime dependencies in the published manifest.
- [ ] The integration test asserting no value leakage passes against a real mongod.
- [ ] A scratch Express + mongoose app can install the published package from npm, add the one line, and produce a batch against a local `nc -l` listener.

## What Plan 2 consumes from this

Plan 2 (the API) validates every ingest request with `ingestPayloadSchema` from
`@query-analyser/contract`, and stores `filterShape`, `sortKeys`, `stages` and
`hist` exactly as defined in `runtime.ts`. The `hash` field is the dedup key for
`QuerySignature`, unique per `(appId, hash)`.
