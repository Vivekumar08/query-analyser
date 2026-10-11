# Web Scaffold and Shared Contract Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up `apps/web` as a deployed blank page behind a path-routed domain that proves same-origin works, give the repo a licence, and move the read endpoints' wire shapes into `packages/contract` so the UI and API agree by compilation.

**Architecture:** A Next.js 16 App Router app joins the existing pnpm + turbo workspace beside `apps/api`. One EasyPanel host routes by path — `/v1/*` and `/healthz` to the API, everything else to the web app — so the refresh cookie already scoped to `/v1/auth` keeps working with no CORS and no `SameSite=None`. The contract package gains the **wire** shapes (what JSON actually carries) plus a compile-time proof that the API's internal types serialise to exactly those shapes.

**Tech Stack:** Next.js 16.4, React 19, Tailwind CSS 4.3 (`@tailwindcss/postcss`, CSS-first config), TypeScript 5.7 strict, vitest 2.1, pnpm 9.12 + turbo 2.3.

**Spec:** `docs/superpowers/specs/2026-10-03-customer-dashboard-design.md`, including its **2026-10-11 amendment** — read both. This plan implements **build steps 1–2 only**. Steps 3–7 (auth, landing, onboarding, dashboard pages) are Plans B and C and are out of scope.

## Global Constraints

- Monorepo is pnpm 9.12 + turbo. `pnpm-workspace.yaml` globs `packages/*` and `apps/*`, so `apps/web` is picked up automatically. Run `pnpm install` from the **repo root**, never from a package directory.
- Root `.npmrc` contains `auto-install-peers=false` and `strict-peer-dependencies=false`. The lockfile records `autoInstallPeers: false` under `settings:`. These must agree or a frozen install fails.
- `tsconfig.base.json` sets `strict`, `noUncheckedIndexedAccess`, `moduleResolution: "Bundler"`, `target: ES2022`. Every package extends it. **No `any` casts anywhere.**
- Node `>=20` per root `engines`. Local Node is v26.7.0.
- **Docker is dead on this machine.** The web Dockerfile cannot be built or run locally. It is written **by inspection only**, and the task that writes it must say so in its report rather than claiming verification it did not do.
- `apps/api` is at **29 test files / 235 tests passing, 0 skipped**, and `npx tsc --noEmit` clean from `apps/api`. Nothing in this plan may reduce either. One pre-existing flake lives in `apps/api/src/ingest/e2e.test.ts`, which fails at the FILE level in `afterAll` → `mongod.stop()` when a cold `mongodb-memory-server` binary download times out, while every test inside it passes. That exact shape is not yours.
- The API is live at `https://prod-query-analyser-api.dhql6p.easypanel.host`.
- Commit with `git -c user.name=vivekumar08 -c user.email=vivekumar2003bsr@gmail.com commit -m "..."`. **Never set commit dates** — no `--date`, no `GIT_AUTHOR_DATE`, no `GIT_COMMITTER_DATE`. Do not push, merge, or open a PR.
- **Never use `git checkout --`, `git stash`, or bare `cp` to undo an edit.** `cp` is aliased to `cp -i` here and silently declines overwrites. Use Edit, or `/bin/cp -f`. After any restore, grep for what you removed, then `git diff HEAD -- <file>`. A clean `git status` is not evidence a restore worked.
- **A mutation run that passes means your mutation did not apply**, or the fixture never reaches the mutated branch. Check both before concluding a test is weak.
- Every gate gets a test that **fails when the gate is removed**. Every pure helper gets mutation-checkable unit tests.
- **No paid or premium component source may be committed.** This repo is public; copy-pasting paid components republishes a paid product as readable source. Free and MIT tiers only. Any vendored component keeps a header comment naming its source and licence. (No components are vendored in this plan — the constraint binds Plans B and C.)

## File Structure

| File | Responsibility |
|---|---|
| `LICENSE` | The repo's licence. Task 1. |
| `apps/web/package.json` | Web app manifest, scripts matching the turbo task names (`build`, `test`, `typecheck`). |
| `apps/web/tsconfig.json` | Extends `tsconfig.base.json`, adds Next's plugin and JSX settings. |
| `apps/web/next.config.ts` | `output: 'standalone'` for the Docker image. Nothing else yet. |
| `apps/web/postcss.config.mjs` | Tailwind 4 via `@tailwindcss/postcss`. |
| `apps/web/app/layout.tsx` | Root layout, imports the stylesheet. |
| `apps/web/app/globals.css` | `@import "tailwindcss";` — Tailwind 4 needs no JS config file. |
| `apps/web/app/page.tsx` | The deliberately blank page step 1 deploys. |
| `apps/web/src/env.ts` | Reads and validates the web app's own environment. One pure function, unit tested. |
| `apps/web/src/env.test.ts` | Tests for the above, with mutation checks. |
| `apps/web/vitest.config.ts` | So `turbo run test` has something real to run. |
| `apps/web/Dockerfile` | Multi-stage build on Next standalone output. Carries both deploy traps. |
| `apps/web/.dockerignore` | Keeps `node_modules` and `.next` out of the build context. |
| `packages/contract/src/wire.ts` | The **wire** shapes: what the read endpoints' JSON actually carries. |
| `packages/contract/src/wire.test.ts` | Runtime tests for the type guards defined alongside the shapes. |
| `packages/contract/src/api-wire-equality.test.ts` | Compile-time proof that `apps/api`'s internal types serialise to `wire.ts`'s shapes. |
| `apps/api/src/analysis/percentile.ts` | Re-exports `PercentileBasis`/`PercentileResult` from the contract instead of defining them. |
| `apps/api/README.md` | Gains the origin-routing table. |

---

### Task 1: The repo's licence

**Files:**
- Create: `LICENSE`
- Modify: `package.json` (add the `license` field)

**Interfaces:**
- Produces: a licensed repository. Nothing imports this; later tasks depend on it only because vendoring MIT component source into an unlicensed repo is incoherent.

**This task carries a decision that is the user's, not the implementer's.** The repo is public with no `LICENSE`, which by default means **all rights reserved**: nobody may legally use, fork, or contribute. That contradicts the stated open-core intent, and it contradicts Plans B and C, which vendor MIT-licensed component source.

The spec names two candidates. The difference that matters here:

- **MIT** — shortest, most permissive, most familiar. No patent grant, no trademark clause.
- **Apache-2.0** — adds an **express patent grant** from contributors and a trademark disclaimer. Preferred when a project may later have commercial/paid components, because the patent grant protects downstream users and the licence is explicit about what contributors convey.

**Recommendation: Apache-2.0**, because the project is explicitly open-core with paid features planned, and Apache-2.0's patent grant and clearer contribution terms suit a project that will take outside contributions against a commercial core. MIT is a perfectly defensible alternative if brevity matters more.

- [ ] **Step 1: Confirm the choice with the user before writing the file**

If the user has already stated a licence, use it. If not, ask — one question, two options, with the recommendation above. **Do not pick silently.** A licence is a legal commitment about other people's rights, and changing it later requires every contributor's agreement.

- [ ] **Step 2: Write the licence file**

Fetch the exact canonical text rather than reciting it from memory — a licence with altered wording is not that licence:

```bash
cd "/Users/vivekkumar/Downloads/Vivek Kumar/Projects/query-analyser"
# Apache-2.0:
curl -sfL https://www.apache.org/licenses/LICENSE-2.0.txt -o LICENSE
# or MIT — fetch from https://opensource.org/license/mit and fill in the
# copyright line with the year and the user's name.
```

For Apache-2.0, the canonical text has an `APPENDIX` with a `[yyyy] [name of copyright owner]` placeholder in the boilerplate comment block at the end. Leave the appendix boilerplate as-is (it is instructions for *users* of the licence, not a blank to fill), but confirm the file is the full text and ends with the appendix.

- [ ] **Step 3: Verify the file is the real thing, not a truncated fetch**

```bash
wc -l LICENSE
head -3 LICENSE
tail -5 LICENSE
```

Expected for Apache-2.0: ~202 lines, first lines `Apache License`, `Version 2.0, January 2004`, and a tail inside the appendix. A file under 150 lines means the fetch truncated — do not commit it.

- [ ] **Step 4: Declare it in the root manifest**

Add the `license` field to `package.json`, after `"private": true`:

```json
  "license": "Apache-2.0",
```

Use the SPDX identifier matching the file (`Apache-2.0` or `MIT`). npm and GitHub both read this field, and a mismatch between it and `LICENSE` is worse than either alone.

- [ ] **Step 5: Commit**

```bash
git add LICENSE package.json
git -c user.name=vivekumar08 -c user.email=vivekumar2003bsr@gmail.com commit -m "chore: licence the repository

Public with no LICENSE means all rights reserved by default, so nobody could
legally use, fork or contribute — the opposite of the stated open-core intent,
and incoherent with vendoring MIT component source into it."
```

---

### Task 2: `apps/web` scaffold that builds, typechecks and tests

**Files:**
- Create: `apps/web/package.json`, `apps/web/tsconfig.json`, `apps/web/next.config.ts`, `apps/web/postcss.config.mjs`, `apps/web/app/layout.tsx`, `apps/web/app/globals.css`, `apps/web/app/page.tsx`, `apps/web/src/env.ts`, `apps/web/src/env.test.ts`, `apps/web/vitest.config.ts`, `apps/web/.gitignore`
- Modify: `pnpm-lock.yaml` (by `pnpm install`)

**Interfaces:**
- Produces: `loadWebEnv(env: Record<string, string | undefined>) => WebEnv` where `interface WebEnv { API_ORIGIN: string }`, exported from `apps/web/src/env.ts`. Task 4 depends on it being validated at startup; Plan B's server-side fetches consume `API_ORIGIN`.

**Why `env.ts` exists in a "blank page" task.** The one thing this scaffold must get right is that the web app knows where the API is, and fails loudly if it does not. That mirrors `apps/api/src/config.ts`, where the SMTP credentials are deliberately required with no defaults so a misconfigured deploy dies at boot naming the variable rather than failing silently later. It is also the only non-trivial logic in this task, so it is what the tests bite on.

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/env.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { loadWebEnv } from './env.js';

const valid = { API_ORIGIN: 'https://api.example.com' };

describe('loadWebEnv', () => {
  it('returns the origin when it is a valid absolute URL', () => {
    expect(loadWebEnv(valid)).toEqual({ API_ORIGIN: 'https://api.example.com' });
  });

  it('throws naming the variable when it is missing', () => {
    // A web app that does not know where its API is must die at startup, not
    // render a page that 404s every fetch. The API's loadConfig does the same.
    expect(() => loadWebEnv({})).toThrow(/API_ORIGIN/);
  });

  it('throws when it is not an absolute URL', () => {
    // A relative value would silently resolve against whatever origin the
    // server happens to be on, which is exactly the bug the path-routed
    // domain exists to make impossible to hit by accident.
    expect(() => loadWebEnv({ API_ORIGIN: '/v1' })).toThrow(/API_ORIGIN/);
  });

  it('strips a trailing slash so callers can concatenate paths safely', () => {
    // Without this, `${API_ORIGIN}/v1/me` becomes `https://x//v1/me`.
    expect(loadWebEnv({ API_ORIGIN: 'https://api.example.com/' }).API_ORIGIN).toBe(
      'https://api.example.com',
    );
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd "/Users/vivekkumar/Downloads/Vivek Kumar/Projects/query-analyser/apps/web"
npx vitest run src/env.test.ts
```

Expected: FAIL — cannot resolve `./env.js`.

- [ ] **Step 3: Write the files**

`apps/web/package.json`:

```json
{
  "name": "@query-analyser/web",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "start": "next start",
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "next": "^16.4.0",
    "react": "^19.0.0",
    "react-dom": "^19.0.0"
  },
  "devDependencies": {
    "@tailwindcss/postcss": "^4.3.3",
    "@types/node": "^22.10.2",
    "@types/react": "^19.0.2",
    "@types/react-dom": "^19.0.2",
    "tailwindcss": "^4.3.3",
    "typescript": "^5.7.2",
    "vitest": "^2.1.8"
  }
}
```

The three script names (`build`, `test`, `typecheck`) are not arbitrary — `turbo.json` declares tasks by those exact names, so a package missing one is silently skipped by `turbo run`.

`apps/web/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "jsx": "preserve",
    "allowJs": true,
    "noEmit": true,
    "incremental": true,
    "plugins": [{ "name": "next" }],
    "paths": { "@/*": ["./*"] }
  },
  "include": ["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts"],
  "exclude": ["node_modules"]
}
```

`lib` must be overridden: the base config sets `["ES2022"]` only, and without `DOM` every React type fails to compile.

`apps/web/next.config.ts`:

```ts
import type { NextConfig } from 'next';

const config: NextConfig = {
  // The Dockerfile copies `.next/standalone`, which only exists with this set.
  // Without it the image has no server to run and the container exits.
  output: 'standalone',
};

export default config;
```

`apps/web/postcss.config.mjs`:

```js
// Tailwind 4 is configured in CSS (`@import "tailwindcss"`), not in a JS
// config file. There is deliberately no tailwind.config.js.
export default {
  plugins: { '@tailwindcss/postcss': {} },
};
```

`apps/web/app/globals.css`:

```css
@import "tailwindcss";
```

`apps/web/app/layout.tsx`:

```tsx
import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Query Analyser',
  description: 'Find the queries costing you the most time.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-white text-slate-900 antialiased">{children}</body>
    </html>
  );
}
```

`apps/web/app/page.tsx` — deliberately almost empty. This page exists to prove the origin split, not to look like anything:

```tsx
export default function Page() {
  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col justify-center gap-2 px-4">
      <h1 className="text-2xl font-semibold">Query Analyser</h1>
      <p className="text-slate-600">
        The web app is deployed. The landing page lands in the next phase.
      </p>
    </main>
  );
}
```

`apps/web/src/env.ts`:

```ts
export interface WebEnv {
  /** Absolute origin of the API, with no trailing slash. */
  API_ORIGIN: string;
}

/**
 * Validates the web app's environment.
 *
 * Mirrors `apps/api/src/config.ts`: the value is required with no default, so
 * a misconfigured deployment fails immediately and names the variable, rather
 * than rendering a page whose every fetch 404s. A relative value is rejected
 * for the same reason — it would resolve against whatever origin the server
 * happens to be on, which is silent and environment-dependent.
 */
export function loadWebEnv(env: Record<string, string | undefined>): WebEnv {
  const raw = env.API_ORIGIN;
  if (!raw) throw new Error('invalid configuration: API_ORIGIN is required');

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`invalid configuration: API_ORIGIN must be an absolute URL, got "${raw}"`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`invalid configuration: API_ORIGIN must be http(s), got "${parsed.protocol}"`);
  }

  return { API_ORIGIN: raw.replace(/\/+$/, '') };
}
```

`apps/web/vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { environment: 'node', include: ['src/**/*.test.ts'] },
});
```

`apps/web/.gitignore`:

```
.next
next-env.d.ts
out
```

- [ ] **Step 4: Install from the repo root**

```bash
cd "/Users/vivekkumar/Downloads/Vivek Kumar/Projects/query-analyser"
pnpm install
```

Expected: `apps/web` appears as a new importer in `pnpm-lock.yaml`. If the install rewrites unrelated lockfile entries, stop and report it rather than committing the churn.

- [ ] **Step 5: Run the test and watch it pass**

```bash
cd apps/web && npx vitest run src/env.test.ts
```

Expected: PASS, 4 tests.

- [ ] **Step 6: Verify the tests are load-bearing**

Three mutations, each must break a *named* test. Restore with Edit after each, then `git diff HEAD -- apps/api/../web/src/env.ts` (i.e. `git diff HEAD -- apps/web/src/env.ts`) to confirm.

1. Delete the `if (!raw)` guard. **"throws naming the variable when it is missing"** must fail.
2. Delete the `protocol` check and the `new URL` try/catch. **"throws when it is not an absolute URL"** must fail.
3. Change `raw.replace(/\/+$/, '')` to `raw`. **"strips a trailing slash"** must fail.

Report which test failed and its assertion message for each. "It failed" without naming the test is not evidence.

- [ ] **Step 7: Build and typecheck for real**

```bash
cd "/Users/vivekkumar/Downloads/Vivek Kumar/Projects/query-analyser/apps/web"
npx tsc --noEmit
API_ORIGIN=https://prod-query-analyser-api.dhql6p.easypanel.host npx next build
```

Expected: typecheck clean, and a successful build that prints a `.next/standalone` output note. `next build` generates `next-env.d.ts` on first run — that file is gitignored and must not be committed.

Then confirm the whole workspace still passes, because you changed the lockfile:

```bash
cd ../.. && pnpm -w run typecheck && pnpm -w run test
```

Expected: `apps/api` still at 235 tests passing, `packages/contract` and `packages/sdk` unchanged.

- [ ] **Step 8: Commit**

```bash
cd "/Users/vivekkumar/Downloads/Vivek Kumar/Projects/query-analyser"
git add apps/web pnpm-lock.yaml
git -c user.name=vivekumar08 -c user.email=vivekumar2003bsr@gmail.com commit -m "feat(web): scaffold apps/web as a deployable blank page

Next 16 App Router with Tailwind 4's CSS-first config, joined to the existing
turbo workspace by the three script names turbo.json declares. The only logic
here is env validation, which is required with no default on purpose: a web app
that does not know where its API is should die at startup naming the variable,
the way the API's loadConfig already does, rather than render a page whose
every fetch 404s."
```

---

### Task 3: The web Dockerfile

**Files:**
- Create: `apps/web/Dockerfile`, `apps/web/.dockerignore`

**Interfaces:**
- Consumes: `apps/web/next.config.ts`'s `output: 'standalone'` (Task 2).
- Produces: an image definition EasyPanel builds. Nothing in the repo imports it.

**This task cannot be verified locally. Docker is dead on this machine.** The Dockerfile is written by inspection against the two traps below and against `apps/api/Dockerfile`, and the first real test is Task 4's deploy. **Say this plainly in your report.** The API's deploy took five rounds precisely because a Dockerfile that looks right is not a Dockerfile that builds.

- [ ] **Step 1: Read the existing API Dockerfile and its documented traps**

```bash
cd "/Users/vivekkumar/Downloads/Vivek Kumar/Projects/query-analyser"
cat apps/api/Dockerfile
sed -n '/## Deploy/,/^## /p' apps/api/README.md
```

Both traps below come from that README. Do not rediscover them.

- [ ] **Step 2: Write `.dockerignore`**

`apps/web/.dockerignore`:

```
node_modules
.next
.git
```

Note the build context is the **repo root**, not `apps/web` — so this file's patterns are relative to the root and will also exclude the root `node_modules`, which is the intent. Shipping the host's `node_modules` into the image both bloats it and can carry platform-specific binaries that do not run in the container.

- [ ] **Step 3: Write the Dockerfile**

`apps/web/Dockerfile`:

```dockerfile
# Build context is the REPO ROOT, not apps/web:
#   docker build -f apps/web/Dockerfile .
FROM node:22-alpine AS base
RUN corepack enable
WORKDIR /app

FROM base AS deps
# TRAP 1: .npmrc must be copied. The lockfile records `autoInstallPeers: false`
# under `settings:`, and the root .npmrc is where that comes from. Without it
# pnpm computes a different settings hash and --frozen-lockfile refuses the
# lockfile as out of date. This cost a round on the API deploy.
COPY .npmrc package.json pnpm-lock.yaml pnpm-workspace.yaml ./
# TRAP 2: EVERY workspace package.json must be present before install.
# --frozen-lockfile validates the lockfile against the workspace it can see, so
# a missing member makes the lockfile look stale and the install fails. Adding
# a new package to the repo means adding a line here.
COPY apps/web/package.json       apps/web/package.json
COPY apps/api/package.json       apps/api/package.json
COPY packages/contract/package.json packages/contract/package.json
COPY packages/sdk/package.json      packages/sdk/package.json
RUN pnpm install --frozen-lockfile

FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/web/node_modules ./apps/web/node_modules
COPY . .
# NOTE: apps/web does not depend on @query-analyser/contract yet, so nothing
# is built here but the web app itself. When Plan B has the UI import the
# contract's wire types, this stage gains
#   COPY --from=deps /app/packages/contract/node_modules ./packages/contract/node_modules
#   RUN pnpm --filter @query-analyser/contract build
# because the contract is consumed through its `dist`, which is not committed.
# Next needs API_ORIGIN present at build time because env.ts validates it.
# This value is NOT baked into the image for runtime use — the server reads the
# real one from the container environment. It is a placeholder that only has to
# parse as a URL.
ENV API_ORIGIN=https://placeholder.invalid
RUN pnpm --filter @query-analyser/web build

FROM base AS run
ENV NODE_ENV=production
ENV PORT=3000
# Next's standalone output is a self-contained server: it bundles only the
# node_modules it actually needs, so this stage installs nothing.
COPY --from=build /app/apps/web/.next/standalone ./
COPY --from=build /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=build /app/apps/web/public ./apps/web/public
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
```

- [ ] **Step 4: Static checks you can actually run without Docker**

You cannot build the image, but you can prove the two traps are covered and that the paths exist:

```bash
cd "/Users/vivekkumar/Downloads/Vivek Kumar/Projects/query-analyser"

# Trap 1 — .npmrc is copied:
grep -q 'COPY .npmrc' apps/web/Dockerfile && echo "TRAP1 OK" || echo "TRAP1 MISSING"

# Trap 2 — every workspace member's package.json is copied. This compares the
# workspace members pnpm actually knows about against the Dockerfile's COPY
# lines, so adding a package later makes this check fail rather than the build.
pnpm -r list --depth -1 --json 2>/dev/null \
  | python3 -c "
import json,sys,os,re
pkgs=json.load(sys.stdin)
root=os.getcwd()
members=[os.path.relpath(p['path'],root) for p in pkgs if os.path.relpath(p['path'],root) != '.']
df=open('apps/web/Dockerfile').read()
missing=[m for m in members if f'{m}/package.json' not in df]
print('workspace members:', members)
print('MISSING FROM DOCKERFILE:', missing if missing else 'none')
"
```

Expected: `TRAP1 OK`, and `MISSING FROM DOCKERFILE: none`. The members are `apps/api`, `apps/web`, `packages/contract`, `packages/sdk`.

Then confirm the files the `run` stage copies will actually exist, by checking the build you ran in Task 2:

```bash
ls apps/web/.next/standalone/apps/web/server.js
ls -d apps/web/.next/static
ls -d apps/web/public 2>/dev/null || mkdir -p apps/web/public && touch apps/web/public/.gitkeep
```

The `public` directory must exist or the `COPY` fails the build — create it with a `.gitkeep` if absent, since git does not track empty directories.

- [ ] **Step 5: Commit**

```bash
git add apps/web/Dockerfile apps/web/.dockerignore apps/web/public/.gitkeep
git -c user.name=vivekumar08 -c user.email=vivekumar2003bsr@gmail.com commit -m "build(web): Dockerfile on Next standalone output, with both known deploy traps

Written by inspection — Docker does not run on this machine, so the first real
test is the deploy. Both traps that cost rounds on the API deploy are built in
from the start: .npmrc must be copied or the lockfile's recorded
autoInstallPeers setting no longer matches and --frozen-lockfile rejects it,
and every workspace package.json must be present or the frozen install fails
validating the lockfile against a workspace it cannot fully see."
```

---

### Task 4: Deploy the blank page and prove the origin split

**Files:** none in the repo except `apps/api/README.md`.

**Interfaces:**
- Consumes: Task 2's build, Task 3's Dockerfile.
- Produces: a verified same-origin deployment. **Plan B's entire auth design rests on this**, so it is proven here before anything is built on it.

**Why this is its own task, before the contract move.** Same-origin is the reason for the path-routed domain: the refresh cookie is already scoped to `/v1/auth` and `Secure`, so same-origin keeps it working with no `SameSite=None` and no CORS allowlist — the part of the system easiest to get subtly wrong simply does not exist. If the routing does not work, every later task's assumptions change. It is cheap to disprove now and expensive to discover late.

**A conflict in the spec's routing rule, resolved here.** The spec says "`/v1/*` to the API, everything else to the web app". Taken literally that sends **`/healthz` to the web app**, where it 404s. `/healthz` is an API route and the deploy's own smoke check. So the routing is **three** path entries, not two:

| Path | Service |
|---|---|
| `/v1` | API |
| `/healthz` | API |
| `/` | web |

EasyPanel matches the longest path prefix, so `/v1` and `/healthz` win over `/` for their own traffic. If EasyPanel's health check is configured against the service's internal port rather than the public domain, the `/healthz` entry is belt-and-braces — keep it anyway, because the documented smoke test in `apps/api/README.md` curls it over the public host.

- [ ] **Step 1: Hand the user the deploy actions**

This step is the user's; it cannot be done from here. Present exactly this:

1. Create a second EasyPanel service in the same project, built from this repo with **Dockerfile path `apps/web/Dockerfile`** and **build context the repo root**.
2. Set its environment: `API_ORIGIN=https://<the shared host>` and `PORT=3000`.
3. On the **shared host**, configure three domain entries as in the table above.
4. On the **API** service, set `WEB_ORIGIN=https://<the shared host>` — the API builds its verification and reset links from it, it is required with no default, and the container fails at boot naming it if absent. It is currently a placeholder.
5. Redeploy both services.

- [ ] **Step 2: Prove the split routes correctly**

With `HOST` set to the shared host:

```bash
HOST="https://<the shared host>"

# web app answers at the root
curl -s -o /dev/null -w "root: %{http_code}\n" "$HOST/"
# API answers under /v1 — 401 is the correct answer for an unauthenticated
# gated route, and proves the API (not the web app) handled it
curl -s -o /dev/null -w "/v1/orgs: %{http_code}\n" -X POST "$HOST/v1/orgs" \
  -H 'content-type: application/json' -d '{"name":"probe"}'
# API's health check is reachable on the shared host
curl -s -w "\n" "$HOST/healthz"
```

Expected: `root: 200`, `/v1/orgs: 401`, `{"status":"ok"}`.

A `root: 200` whose body is JSON means the API is serving `/` and the paths are inverted. A `/v1/orgs: 404` with an HTML body means the web app is swallowing API traffic.

- [ ] **Step 3: Prove it is genuinely same-origin, which is the whole point**

Same status codes could be produced by a proxy that still crosses origins. What matters is that the browser would treat these as one origin, and that the refresh cookie comes back scoped as the API already sets it:

```bash
# Sign up a throwaway account and keep the cookie jar, then exercise refresh.
EMAIL="origin-probe-$(date +%s)@example.invalid"
curl -s -c /tmp/qa_jar.txt -o /tmp/qa_signup.json -w "signup: %{http_code}\n" \
  -X POST "$HOST/v1/auth/signup" -H 'content-type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"password\":\"correct-horse-battery-staple-9\",\"name\":\"Origin Probe\"}"

# The refresh cookie must be present, Secure, HttpOnly, and scoped to /v1/auth.
grep -i 'refresh' /tmp/qa_jar.txt

# And it must actually work against the shared host:
curl -s -b /tmp/qa_jar.txt -c /tmp/qa_jar.txt -o /dev/null \
  -w "refresh: %{http_code}\n" -X POST "$HOST/v1/auth/refresh"
```

Expected: `signup: 201`, a cookie line whose path column is `/v1/auth` with the secure flag set, and `refresh: 200`. A `refresh: 401` on the shared host while the same call works on the API's own host means the cookie is not being sent — which is the exact failure the same-origin design exists to prevent, and it must be fixed before Plan B starts.

Record the throwaway account's email so it can be deleted:

```sql
DELETE FROM "User" WHERE email LIKE 'origin-probe-%@example.invalid';
```

- [ ] **Step 4: Document the routing where the next person will look**

Add to `apps/api/README.md`, in the Deploy section:

```markdown
### Origin routing

One host serves both services, routed by path. EasyPanel matches the longest
prefix, so these are three domain entries:

| Path | Service |
|---|---|
| `/v1` | API |
| `/healthz` | API |
| `/` | web |

Same-origin is the reason for this rather than two hosts: the refresh cookie is
scoped to `/v1/auth` and `Secure`, so it keeps working untouched — no
`SameSite=None`, no CORS allowlist, no preflight. `WEB_ORIGIN` on the API and
`API_ORIGIN` on the web service both point at this one host.
```

- [ ] **Step 5: Commit**

```bash
git add apps/api/README.md
git -c user.name=vivekumar08 -c user.email=vivekumar2003bsr@gmail.com commit -m "docs(api): record the path-routed origin split

Three entries, not the two the spec implies: taken literally, 'everything that
is not /v1 goes to the web app' sends /healthz to the web app, where the
deploy's own smoke check 404s."
```

---

### Task 5: Move the read endpoints' wire shapes into the contract

**Files:**
- Create: `packages/contract/src/wire.ts`, `packages/contract/src/wire.test.ts`, `packages/contract/src/api-wire-equality.test.ts`
- Modify: `packages/contract/src/index.ts`, `apps/api/src/analysis/percentile.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces, all exported from `@query-analyser/contract`:
  - `type NumericString = string`
  - `type PercentileBasis = 'interpolated' | 'floor'`
  - `interface PercentileResult { value: number; basis: PercentileBasis }`
  - `interface RankedQueryRow { hash: string; signature: string; model: string; operation: string; count: number; totalMs: NumericString; maxMs: number; hist: number[] }`
  - `type Serialized<T>`
  - `const isPercentileBasis: (v: unknown) => v is PercentileBasis`
  - `const parseNumericString: (v: NumericString) => number`

**The distinction this task exists to encode, and the trap in it.** `apps/api/src/analysis/routes.ts` defines `RankRow` with **`totalMs: bigint`**, and `apps/api/src/app.ts` installs a reply serializer that converts `bigint` to a string at the JSON boundary. So the type the API holds in memory is **not** the type the UI receives: the wire carries `totalMs` as a **numeric string**.

Moving `RankRow` to the contract as-is and importing it in the UI would be worse than hand-copied interfaces, because it would **compile** while being wrong at runtime everywhere. The contract therefore defines the *wire* shapes, and a compile-time check proves the API's internal types serialise to exactly them.

`Date` has the same property: `JSON.stringify` turns a `Date` into an ISO string, so the detail payload's `firstSeen`/`lastSeen` are `string` on the wire.

- [ ] **Step 1: Write the failing tests**

Create `packages/contract/src/wire.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { isPercentileBasis, parseNumericString } from './wire.js';

describe('isPercentileBasis', () => {
  it('accepts the two documented bases', () => {
    expect(isPercentileBasis('interpolated')).toBe(true);
    expect(isPercentileBasis('floor')).toBe(true);
  });

  it('rejects anything else, including near-misses', () => {
    // The UI renders `p95 ≈` for interpolated and `p95 ≥` for floor. A third
    // value arriving unnoticed would render as one of them and silently claim
    // precision the service did not promise.
    expect(isPercentileBasis('exact')).toBe(false);
    expect(isPercentileBasis('Floor')).toBe(false);
    expect(isPercentileBasis('')).toBe(false);
    expect(isPercentileBasis(undefined)).toBe(false);
    expect(isPercentileBasis(null)).toBe(false);
    expect(isPercentileBasis(0)).toBe(false);
  });
});

describe('parseNumericString', () => {
  it('converts a wire numeric string to a number', () => {
    expect(parseNumericString('0')).toBe(0);
    expect(parseNumericString('1234')).toBe(1234);
  });

  it('throws on a value that is not an integer string', () => {
    // totalMs arrives as a string because it is a BigInt behind the API's
    // serializer. Anything else means the contract and the API have drifted,
    // and failing loudly beats rendering NaN in a latency column.
    expect(() => parseNumericString('')).toThrow();
    expect(() => parseNumericString('abc')).toThrow();
    expect(() => parseNumericString('12.5')).toThrow();
  });

  it('throws rather than silently losing precision above Number.MAX_SAFE_INTEGER', () => {
    // A busy app's summed totalMs can exceed 2^53. Returning a quietly wrong
    // number here would understate the one figure the product exists to rank
    // on, so the caller is told instead.
    expect(() => parseNumericString('9007199254740993')).toThrow(/precision/i);
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

```bash
cd "/Users/vivekkumar/Downloads/Vivek Kumar/Projects/query-analyser/packages/contract"
npx vitest run src/wire.test.ts
```

Expected: FAIL — cannot resolve `./wire.js`.

- [ ] **Step 3: Write `wire.ts`**

```ts
/**
 * The shapes the read endpoints' JSON actually carries.
 *
 * These are deliberately NOT the API's internal types. `apps/api` holds
 * `totalMs` as a `bigint` and `firstSeen`/`lastSeen` as `Date`s; the reply
 * serializer in `apps/api/src/app.ts` turns the former into a string and
 * `JSON.stringify` turns the latter into ISO strings. A UI typed against the
 * internal shapes would compile and be wrong at runtime everywhere, which is
 * worse than a hand-copied interface. `api-wire-equality.test.ts` proves these
 * shapes are exactly what serialisation produces.
 */

/** A base-10 integer carried as a string because it exceeds JSON's safe range. */
export type NumericString = string;

/**
 * `interpolated` — the rank fell in a bounded histogram bucket and the value is
 * a linear estimate inside it.
 * `floor` — the rank fell in the unbounded top bucket (or there is no data), so
 * the value is the largest observation recorded and the real percentile is at
 * least this.
 */
export type PercentileBasis = 'interpolated' | 'floor';

export interface PercentileResult {
  /** Milliseconds. */
  value: number;
  basis: PercentileBasis;
}

/** One row of the ranked query list. */
export interface RankedQueryRow {
  hash: string;
  signature: string;
  model: string;
  operation: string;
  count: number;
  /** Summed milliseconds. A string: see NumericString. */
  totalMs: NumericString;
  maxMs: number;
  hist: number[];
}

/**
 * What `JSON.stringify` plus the API's reply serializer do to a type.
 *
 * `bigint` becomes a string (the serializer), `Date` becomes a string
 * (JSON.stringify calls toJSON), and everything else recurses. This is how the
 * equality test states "the wire shape is the serialisation of the internal
 * shape" as a type rather than as a comment.
 */
export type Serialized<T> = T extends bigint
  ? NumericString
  : T extends Date
    ? string
    : T extends (infer U)[]
      ? Serialized<U>[]
      : T extends object
        ? { [K in keyof T]: Serialized<T[K]> }
        : T;

const BASES: readonly PercentileBasis[] = ['interpolated', 'floor'];

export const isPercentileBasis = (v: unknown): v is PercentileBasis =>
  typeof v === 'string' && (BASES as readonly string[]).includes(v);

/**
 * Converts a wire numeric string to a number, refusing anything it cannot
 * represent exactly.
 *
 * The UI does arithmetic on `totalMs` (shares of total time, averages), so the
 * conversion happens once, here, rather than at each call site.
 */
export function parseNumericString(v: NumericString): number {
  if (!/^-?\d+$/.test(v)) {
    throw new Error(`expected a base-10 integer string, got "${v}"`);
  }
  const asBig = BigInt(v);
  if (asBig > BigInt(Number.MAX_SAFE_INTEGER) || asBig < BigInt(-Number.MAX_SAFE_INTEGER)) {
    throw new Error(`"${v}" exceeds Number.MAX_SAFE_INTEGER; converting would lose precision`);
  }
  return Number(asBig);
}
```

- [ ] **Step 4: Run them and watch them pass**

```bash
npx vitest run src/wire.test.ts
```

Expected: PASS, 5 tests.

- [ ] **Step 5: Export it, and make the API consume the shared percentile types**

Add to `packages/contract/src/index.ts`:

```ts
export * from './wire.js';
```

Then in `apps/api/src/analysis/percentile.ts`, replace the local definitions of `PercentileBasis` and `PercentileResult` with re-exports, leaving the rest of the file untouched:

```ts
import type { PercentileBasis, PercentileResult } from '@query-analyser/contract';

export type { PercentileBasis, PercentileResult };
```

Delete the two local declarations (`export type PercentileBasis = ...` and `export interface PercentileResult { ... }`) — including their doc comment, which now lives in `wire.ts`. Everything that imports these from `./percentile.js` keeps working, because the re-export preserves the names.

`PercentileResult` is safe to share wholesale because it contains no `bigint` and no `Date` — its wire shape and its internal shape are identical. `RankRow` is not, which is what the next step proves.

- [ ] **Step 6: Write the compile-time proof that the wire shapes match serialisation**

Create `packages/contract/src/api-wire-equality.test.ts`, following the idiom already used by `sdk-types-equality.test.ts` in this package:

```ts
/**
 * Proves that the wire shapes in `wire.ts` are exactly what the API's internal
 * types become after serialisation.
 *
 * This is a compile-time check (via `tsc --noEmit`, which this package's
 * `typecheck` and `build` scripts run). If someone changes `RankRow` in the API
 * without changing `RankedQueryRow` here — or vice versa — this file stops
 * compiling. The runtime assertion at the bottom only gives the check a home
 * in `vitest run` output too.
 *
 * It is the whole reason the wire shapes live in this package rather than being
 * hand-copied into the UI: `RankRow.totalMs` is a `bigint`, and the UI receives
 * a string. A UI typed against the internal shape would compile and be wrong.
 */
import type { Serialized, RankedQueryRow } from './wire.js';
import type { RankRow } from '../../../apps/api/src/analysis/routes.js';
import { describe, it, expect } from 'vitest';

// Mutually-assignable (structural equality). `Equal<A, B>` is `true` only when
// A and B accept exactly the same set of values.
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
  ? true
  : false;
type AssertTrue<T extends true> = T;

type _RankedRow = AssertTrue<Equal<Serialized<RankRow>, RankedQueryRow>>;

describe('wire shapes are the serialisation of the API internal shapes', () => {
  it('compiles (the real assertion is the type-level check above)', () => {
    expect(true).toBe(true);
  });
});
```

- [ ] **Step 7: Prove the compile-time check is load-bearing**

A type test that cannot fail is decorative, and this one is the entire justification for the task. Verify it bites:

1. In `packages/contract/src/wire.ts`, change `RankedQueryRow.totalMs` from `NumericString` to `number`.
2. Run `npx tsc --noEmit` from `packages/contract`.
3. Expected: **FAIL**, on the `_RankedRow` line, with a message about `AssertTrue<false>` / `Type 'false' does not satisfy the constraint 'true'`.
4. Restore with Edit, re-run `npx tsc --noEmit` (expected: clean), then `git diff HEAD -- packages/contract/src/wire.ts` to confirm the restore.

Repeat with a second mutation to be sure it is not passing for an unrelated reason: add a field (`foo: string`) to `RankedQueryRow`, confirm `tsc` fails, restore, confirm clean.

Report both failure messages. If either mutation **passes**, the check is not wired up — most likely the relative import path to `apps/api` is wrong, or `RankRow` resolved to `any`. Investigate before concluding the test works.

- [ ] **Step 8: Confirm nothing else broke, then commit**

The contract package is a dependency of `apps/api`, so changing it can reach the API's typecheck and tests:

```bash
cd "/Users/vivekkumar/Downloads/Vivek Kumar/Projects/query-analyser"
pnpm --filter @query-analyser/contract build
pnpm -w run typecheck
pnpm -w run test
```

Expected: contract tests pass including the two new files, `apps/api` still **235 tests passing** with `tsc` clean, `packages/sdk` unchanged at 104.

```bash
git add packages/contract/src apps/api/src/analysis/percentile.ts
git -c user.name=vivekumar08 -c user.email=vivekumar2003bsr@gmail.com commit -m "feat(contract): define the read endpoints' wire shapes, and prove them

The API holds totalMs as a bigint and lastSeen as a Date; the reply serializer
and JSON.stringify turn those into strings. So the type the API holds is not
the type the UI receives, and moving the internal shapes into the contract
would have been worse than hand-copying them — it would compile while being
wrong at runtime everywhere.

The contract therefore carries the WIRE shapes, plus a Serialized<T> mapped
type and a compile-time equality check proving each wire shape is exactly the
serialisation of its internal counterpart. Change one without the other and
tsc fails."
```

---

## Self-Review

**Spec coverage (steps 1–2 only; steps 3–7 are Plans B and C)**

| Spec requirement | Task |
|---|---|
| `apps/web` in the existing monorepo beside `apps/api` | 2 |
| Next.js App Router + Tailwind | 2 |
| Dockerfile using Next's standalone output | 3 |
| `.npmrc` copied / every workspace `package.json` copied | 3 |
| Second EasyPanel service, path-routed domain | 4 |
| Deploy a blank page and prove the origin split first | 4 |
| Same-origin keeps the `/v1/auth` refresh cookie working | 4, Step 3 |
| Repo needs a LICENSE (amendment moved it to step 1) | 1 |
| `WEB_ORIGIN` set to the web host (amendment) | 4, Step 1 |
| Response shapes move to `packages/contract` | 5 |
| `totalMs` arrives as a numeric string | 5 |
| `p95`/`p99` carry `basis`, UI must render `≈` vs `≥` | 5 (types + guard; the `<Percentile>` component is Plan C) |
| Mutation-checkable tests on pure helpers | 2 Step 6, 5 Steps 7 |

**Deliberately not in this plan**, and belonging to Plans B/C: the session cookie and refresh single-flight guard, route guards, the landing page and its animation stack, onboarding, `formatMs`, the `<Percentile>` component, and all five dashboard pages. The spec's §Testing items for `<Percentile>` and the auth guards land with the code they test.

**Placeholder scan:** clean. Every code step carries real code. The two judgement calls are named rather than hidden: Task 1 Step 1 stops for the licence decision instead of assuming one, and Task 4 Step 1 hands the user the EasyPanel actions that cannot be performed from here.

**Type consistency:** `WebEnv`/`loadWebEnv` (Task 2) are referenced nowhere later in this plan, as intended — Plan B consumes them. `PercentileBasis`, `PercentileResult`, `RankedQueryRow`, `NumericString`, `Serialized<T>`, `isPercentileBasis`, `parseNumericString` are all defined in Task 5 Step 3 and used with those exact names in Steps 5–7. `RankRow` is referenced only as an import from `apps/api/src/analysis/routes.ts`, where it already exists with `totalMs: bigint`.

**Three things I resolved while writing this, which the spec did not settle**

**The routing rule as written breaks `/healthz`.** "`/v1/*` to the API, everything else to the web app" sends the API's health endpoint — which `apps/api/README.md`'s own smoke test curls over the public host — to the web app, where it 404s. Task 4 uses three path entries instead of two and documents the table in the README.

**The web Dockerfile does not build the contract package.** An earlier draft had
it do so, which was incoherent: `apps/web/package.json` does not depend on
`@query-analyser/contract` in this plan, because nothing in the blank page
imports it. Building it would have been an unexplained step with its own failure
mode. The Dockerfile carries a comment naming the two lines Plan B adds when the
UI first imports the wire types, since the contract is consumed through a `dist`
that is not committed.

**The detail payload is not fully typed here, on purpose.** `GET /v1/apps/:id/queries/:sig` returns `advice: signature.advice`, a Prisma model whose serialised shape depends on the generated client rather than on a hand-written interface. Pinning it with `Serialized<>` would mean importing Prisma's generated types into `packages/contract`, which would make a browser-facing package depend on the ORM. The ranked row and `PercentileResult` — the two shapes the spec names as binding on the UI — are typed and proven; the detail payload's `advice` field gets its interface in Plan C, where the page that renders it lands and the right boundary is visible. This is a deliberate scope line, not an oversight.
