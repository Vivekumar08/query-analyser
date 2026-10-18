# Web Auth and Landing Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give `apps/web` real authentication — an httpOnly session cookie the web app sets itself, a serialised refresh, and route guards — plus the public landing page that makes the link worth sharing.

**Architecture:** The access token never reaches client JavaScript. Browser → Next route handler → API, with the handler setting its own `qa_session` cookie and forwarding the API's `qa_refresh` cookie onward. Server Components read the session cookie and call the API directly; a 401 redirects to a refresh route handler which rotates the pair under a single-flight guard and bounces back exactly once. `proxy.ts` handles redirect UX, but the real gate lives at the data layer, because Next's own docs say not to rely on proxy alone.

**Tech Stack:** Next.js 16.4 App Router (Node runtime), React 19, Tailwind 4 (CSS-first), Motion (`framer-motion` v14, MIT), vitest 2.1, TypeScript strict.

**Spec:** `docs/superpowers/specs/2026-10-03-customer-dashboard-design.md` — read it **and its 2026-10-11 amendment**. This plan implements **build steps 3–4 only**. Plan A (steps 1–2) is merged at `36a8f3d` and deployed. Steps 5–7 are Plan C.

## Global Constraints

- **Verified live, do not re-derive.** Shared host `https://prod-query-analyser.dhql6p.easypanel.host`, three path-routed entries: `/` → web:3000, `/v1` → api:8080, `/healthz` → api:8080. Same-origin is proven: signup there sets `qa_refresh` (HttpOnly, Secure, `path=/v1/auth`) and `POST /v1/auth/refresh` returns 200.
- **API response shapes, read from `apps/api/src/auth/routes.ts`:** `POST /v1/auth/signup` → **201** `{ accessToken, user }`; `POST /v1/auth/login` → **200** `{ accessToken, user: { id, email, name, isPlatformAdmin } }`; `POST /v1/auth/refresh` → **200** `{ accessToken }` (**no `user`**); `POST /v1/auth/logout` → **204**; `GET /v1/me` → `{ id, email, name, isPlatformAdmin, emailVerifiedAt }` or 401.
- The API's refresh cookie is `qa_refresh`, `httpOnly`, `sameSite: 'lax'`, `path: '/v1/auth'`, `secure` in production.
- **The gate returns `{"error":"email not verified","code":"email_not_verified"}` with 403. Branch on `code`, never the prose string** — the message may be reworded, the code is the contract.
- Access tokens expire in **15 minutes** (`expiresIn: '15m'` in `apps/api/src/plugins/auth.ts`).
- **Signup takes ~3.2–3.5s**, measured live, because the API awaits the verification mail. Every signup form needs a pending state that tolerates it.
- `middleware.ts` is **deprecated in Next 16 and renamed `proxy.ts`**, exporting `proxy`, Node runtime by default.
- `tsconfig.base.json` sets `strict` and `noUncheckedIndexedAccess`. **No `any` casts.**
- `turbo.json` declares tasks named exactly `build`, `test`, `typecheck` — a package missing one is silently skipped.
- **One animation runtime: Motion.** Vengeance UI (MIT) components are copy-pasted and become our code, each keeping a header comment naming source and licence. **No paid or premium component source may be committed** — the repo is public. No WebGL, no second animation library, respect `prefers-reduced-motion`.
- Commit with `git -c user.name=vivekumar08 -c user.email=vivekumar2003bsr@gmail.com commit -m "..."`. **Never set commit dates.** Do not push, merge, or open a PR.
- **Docker is dead on this machine**; the image cannot be built locally. **There is no CI in this repo** — every gate is human-run, which is why each one must be proven to fail.
- **Never use `git checkout --`, `git stash`, or bare `cp` to undo an edit.** Use Edit, or `/bin/cp -f`. After a restore, `git diff HEAD -- <file>` for a **tracked** file; for an **untracked** one that diff is empty regardless — use `git add -N` first or verify by direct read plus grep.
- **A mutation run that passes means the mutation did not apply.** In five separate gates across three prior phases, the test existed and the assertion was too loose to fail. Every gate here gets proven.
- **Baseline:** `apps/web` 5/5, `packages/contract` 16/16, `apps/api` 236/236, `packages/sdk` 104/104; `pnpm -w run typecheck` and `test` both 6/6. One pre-existing flake: `apps/api/src/ingest/e2e.test.ts` fails at the FILE level in `afterAll` → `mongod.stop()` on a cold `mongodb-memory-server` download while its tests pass.

## File Structure

| File | Responsibility |
|---|---|
| `apps/web/src/session.ts` | Session cookie name, options, and the pure helpers that build them. Unit tested. |
| `apps/web/src/session.test.ts` | Tests for the above, with mutation checks. |
| `apps/web/src/single-flight.ts` | A generic single-flight guard. Pure, no Next imports, heavily unit tested. |
| `apps/web/src/single-flight.test.ts` | Tests for the above, with mutation checks. |
| `apps/web/src/api.ts` | Server-side API client: reads env per request, attaches the session cookie, returns a discriminated result rather than throwing. |
| `apps/web/src/api.test.ts` | Tests for the above. |
| `apps/web/src/auth.ts` | `requireSession()` / `getSession()` — the data-layer gate every protected read goes through. |
| `apps/web/src/auth.test.ts` | Tests, including the gate-removal proof. |
| `apps/web/app/api/auth/login/route.ts` | POSTs to the API, sets `qa_session`, forwards `qa_refresh`. |
| `apps/web/app/api/auth/signup/route.ts` | Same, for signup. |
| `apps/web/app/api/auth/logout/route.ts` | Clears `qa_session`, calls the API, clears `qa_refresh`. |
| `apps/web/app/api/auth/refresh/route.ts` | Single-flight refresh, rotates both cookies, redirects back once. |
| `apps/web/proxy.ts` | Redirect UX for unauthenticated navigation. Not the real gate. |
| `apps/web/app/login/page.tsx`, `app/signup/page.tsx` | The auth screens. |
| `apps/web/app/verify/page.tsx`, `app/reset-password/page.tsx` | The screens the email links point at. |
| `apps/web/app/page.tsx` | The landing page (replaces the Plan A placeholder). |
| `apps/web/app/_components/landing/*.tsx` | Landing sections. Server components by default; Motion leaves marked `'use client'`. |

---

### Task 1: The session cookie and the single-flight guard

**Files:**
- Create: `apps/web/src/session.ts`, `apps/web/src/session.test.ts`, `apps/web/src/single-flight.ts`, `apps/web/src/single-flight.test.ts`

**Interfaces:**
- Produces: `SESSION_COOKIE = 'qa_session'`, `sessionCookieOptions(isProd: boolean): CookieOptions`, `type CookieOptions = { httpOnly: true; secure: boolean; sameSite: 'lax'; path: '/'; maxAge: number }`, `SESSION_MAX_AGE_SECONDS = 900`
- Produces: `singleFlight<T>(): <K extends string>(key: K, fn: () => Promise<T>) => Promise<T>`

**Why these two live together.** Both are pure, dependency-free helpers with no Next imports, and both are load-bearing for everything after them. Keeping them in one task means one review of the primitives before any route handler depends on them.

- [ ] **Step 1: Write the failing tests**

Create `apps/web/src/session.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { SESSION_COOKIE, SESSION_MAX_AGE_SECONDS, sessionCookieOptions } from './session.js';

describe('session cookie', () => {
  it('is named distinctly from the API\'s refresh cookie', () => {
    // The API sets `qa_refresh` on path /v1/auth. If the web app reused that
    // name it would overwrite the refresh token with an access token and
    // silently destroy every session on the next refresh.
    expect(SESSION_COOKIE).toBe('qa_session');
    expect(SESSION_COOKIE).not.toBe('qa_refresh');
  });

  it('is httpOnly, so the access token never reaches client JavaScript', () => {
    // This is the spec's core auth requirement. If httpOnly is ever dropped,
    // any XSS on the page can read the token.
    expect(sessionCookieOptions(true).httpOnly).toBe(true);
    expect(sessionCookieOptions(false).httpOnly).toBe(true);
  });

  it('is Secure in production and not in development', () => {
    // Secure in dev would make the cookie unusable over http://localhost.
    expect(sessionCookieOptions(true).secure).toBe(true);
    expect(sessionCookieOptions(false).secure).toBe(false);
  });

  it('is lax and path-wide, so it is sent on same-origin navigations', () => {
    expect(sessionCookieOptions(true).sameSite).toBe('lax');
    expect(sessionCookieOptions(true).path).toBe('/');
  });

  it('expires no later than the access token it carries', () => {
    // The API signs access tokens with expiresIn '15m'. A cookie outliving
    // its token means every request inside the gap 401s and triggers a
    // refresh redirect that did not need to happen.
    expect(SESSION_MAX_AGE_SECONDS).toBe(900);
    expect(sessionCookieOptions(true).maxAge).toBe(900);
  });
});
```

Create `apps/web/src/single-flight.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { singleFlight } from './single-flight.js';

const deferred = <T>() => {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};

describe('singleFlight', () => {
  it('runs the work once for concurrent callers on the same key', async () => {
    // This is the whole point. Two concurrent server renders both hitting a
    // 401 would both call /v1/auth/refresh; the API's family-revocation
    // treats the second as a replay and logs the user out entirely.
    const run = singleFlight<string>();
    const d = deferred<string>();
    const fn = vi.fn(() => d.promise);

    const a = run('k', fn);
    const b = run('k', fn);
    d.resolve('token');

    expect(await a).toBe('token');
    expect(await b).toBe('token');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('keeps different keys independent', async () => {
    const run = singleFlight<string>();
    const fn = vi.fn(async (v: string) => v);
    const [x, y] = await Promise.all([run('a', () => fn('a')), run('b', () => fn('b'))]);
    expect([x, y]).toEqual(['a', 'b']);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('releases the key after success, so a later call does fresh work', async () => {
    // Without release, one refresh would be cached forever and the session
    // would die the moment that token expired.
    const run = singleFlight<number>();
    const fn = vi.fn(async () => 1);
    await run('k', fn);
    await run('k', fn);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('releases the key after failure, so a transient error is retryable', async () => {
    // A rejected promise left in the map would make every subsequent refresh
    // fail with the same stale error, permanently.
    const run = singleFlight<number>();
    const bad = vi.fn(async () => { throw new Error('nope'); });
    await expect(run('k', bad)).rejects.toThrow('nope');
    const good = vi.fn(async () => 7);
    expect(await run('k', good)).toBe(7);
  });

  it('propagates the rejection to every concurrent caller', async () => {
    const run = singleFlight<number>();
    const d = deferred<number>();
    const fn = () => d.promise;
    const a = run('k', fn);
    const b = run('k', fn);
    d.reject(new Error('boom'));
    await expect(a).rejects.toThrow('boom');
    await expect(b).rejects.toThrow('boom');
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

```bash
cd "/Users/vivekkumar/Downloads/Vivek Kumar/Projects/query-analyser/apps/web"
npx vitest run src/session.test.ts src/single-flight.test.ts
```

Expected: FAIL — cannot resolve `./session.js` or `./single-flight.js`.

- [ ] **Step 3: Write the implementations**

`apps/web/src/session.ts`:

```ts
/** The web app's own cookie. Distinct from the API's `qa_refresh`. */
export const SESSION_COOKIE = 'qa_session';

/**
 * Matches the API's access-token lifetime (`expiresIn: '15m'`).
 *
 * A cookie that outlives its token is worse than one that expires with it:
 * every request in the gap 401s and triggers a refresh redirect that a
 * correctly-sized cookie would have made unnecessary.
 */
export const SESSION_MAX_AGE_SECONDS = 900;

export interface CookieOptions {
  httpOnly: true;
  secure: boolean;
  sameSite: 'lax';
  path: '/';
  maxAge: number;
}

/**
 * `httpOnly` is the spec's core auth requirement: the access token must never
 * reach client JavaScript, so an XSS on any page cannot read it.
 *
 * `secure` is conditional only so the cookie works over http://localhost in
 * development; it is always true in production.
 */
export function sessionCookieOptions(isProd: boolean): CookieOptions {
  return {
    httpOnly: true,
    secure: isProd,
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_MAX_AGE_SECONDS,
  };
}
```

`apps/web/src/single-flight.ts`:

```ts
/**
 * Collapses concurrent calls for the same key into one execution.
 *
 * The refresh endpoint is why this exists. The API rotates refresh tokens and
 * revokes the whole family on replay, so two concurrent refreshes with the
 * same token look like an attack: the first rotates, the second presents a
 * consumed token, and the user is logged out of everything. Serialising them
 * turns that into one rotation both callers share.
 *
 * Deliberately has no Next imports. Next 16's docs say proxy "should not
 * attempt relying on shared modules or globals", so this must be used from a
 * route handler, never from proxy.ts.
 *
 * Scope note: this is per-process. With more than one web replica a refresh
 * could still race across instances. The deployment runs a single replica, so
 * it is effective here; a shared lock would be the fix if that changes.
 */
export function singleFlight<T>() {
  const inFlight = new Map<string, Promise<T>>();

  return function run(key: string, fn: () => Promise<T>): Promise<T> {
    const existing = inFlight.get(key);
    if (existing) return existing;

    // `finally` rather than `then`: the key must be released on rejection too,
    // or one transient failure poisons every later call with a stale error.
    const promise = fn().finally(() => {
      inFlight.delete(key);
    });
    inFlight.set(key, promise);
    return promise;
  };
}
```

- [ ] **Step 4: Run them and watch them pass**

```bash
npx vitest run src/session.test.ts src/single-flight.test.ts
```

Expected: PASS, 10 tests (5 + 5).

- [ ] **Step 5: Prove every gate is load-bearing**

Four mutations. Each must break a **named** test. Restore with Edit after each, then `git diff HEAD -- <file>` (both files are new and untracked until the commit — use `git add -N apps/web/src/session.ts apps/web/src/single-flight.ts` first so the diff is meaningful).

1. In `sessionCookieOptions`, change `httpOnly: true` to `httpOnly: false as true`. **"is httpOnly, so the access token never reaches client JavaScript"** must FAIL.
2. In `sessionCookieOptions`, change `secure: isProd` to `secure: true`. **"is Secure in production and not in development"** must FAIL.
3. In `singleFlight`, delete the `if (existing) return existing;` line. **"runs the work once for concurrent callers on the same key"** must FAIL on the call count.
4. In `singleFlight`, change `.finally(...)` to `.then((v) => { inFlight.delete(key); return v; })`. **"releases the key after failure, so a transient error is retryable"** must FAIL.

Report the failing test name and assertion message for each. "It failed" without naming the test is not evidence.

- [ ] **Step 6: Typecheck and commit**

```bash
npx tsc --noEmit
git add apps/web/src/session.ts apps/web/src/session.test.ts apps/web/src/single-flight.ts apps/web/src/single-flight.test.ts
git -c user.name=vivekumar08 -c user.email=vivekumar2003bsr@gmail.com commit -m "feat(web): session cookie options and a single-flight guard

Two pure primitives everything else rests on. The guard exists because the API
rotates refresh tokens and revokes the family on replay — two concurrent
refreshes with the same token look like an attack and log the user out of
everything. It releases its key in a finally rather than a then, or one
transient failure would poison every later refresh with a stale error."
```

---

### Task 2: The server-side API client

**Files:**
- Create: `apps/web/src/api.ts`, `apps/web/src/api.test.ts`
- Modify: `apps/web/package.json` (add `@query-analyser/contract`), `apps/web/Dockerfile` (the two lines its own comment names)

**Interfaces:**
- Consumes: `SESSION_COOKIE` (Task 1), `loadWebEnv` from `./env.js` (Plan A)
- Produces: `type ApiResult<T> = { ok: true; data: T } | { ok: false; status: number; code?: string; error: string }`, `apiFetch<T>(path: string, init?: RequestInit, accessToken?: string): Promise<ApiResult<T>>`, `apiOrigin(): string`

**The rule this task exists to enforce.** `loadWebEnv` must be called **per request**, not at module scope. The Dockerfile sets `API_ORIGIN=https://placeholder.invalid` at build time, so a module-scope read captures the placeholder and bakes it into any statically prerendered RSC payload. `apiOrigin()` reads `process.env` on every call for exactly that reason.

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/api.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { apiFetch, apiOrigin } from './api.js';

const ORIGIN = 'https://api.example.com';
let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  process.env.API_ORIGIN = ORIGIN;
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const mockFetch = (status: number, body: unknown, headers: Record<string, string> = {}) => {
  const fn = vi.fn(async () => new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  }));
  globalThis.fetch = fn as unknown as typeof globalThis.fetch;
  return fn;
};

describe('apiOrigin', () => {
  it('reads the environment on every call, never at module scope', () => {
    // The Dockerfile sets API_ORIGIN=https://placeholder.invalid at BUILD
    // time. A module-scope read would capture the placeholder and bake it
    // into every statically prerendered payload.
    expect(apiOrigin()).toBe(ORIGIN);
    process.env.API_ORIGIN = 'https://other.example.com';
    expect(apiOrigin()).toBe('https://other.example.com');
  });
});

describe('apiFetch', () => {
  it('returns ok with parsed data on 200', async () => {
    mockFetch(200, { id: 'u1' });
    const res = await apiFetch<{ id: string }>('/v1/me');
    expect(res).toEqual({ ok: true, data: { id: 'u1' } });
  });

  it('attaches the bearer token when one is given, and omits it otherwise', async () => {
    const fn = mockFetch(200, {});
    await apiFetch('/v1/me', undefined, 'tok123');
    const withTok = new Headers((fn.mock.calls[0]![1] as RequestInit).headers);
    expect(withTok.get('authorization')).toBe('Bearer tok123');

    const fn2 = mockFetch(200, {});
    await apiFetch('/v1/me');
    const without = new Headers((fn2.mock.calls[0]![1] as RequestInit).headers);
    expect(without.has('authorization')).toBe(false);
  });

  it('surfaces the machine-readable code on a 403, not just the message', async () => {
    // The gate returns {"error":"email not verified","code":"email_not_verified"}.
    // Guards branch on `code`; the prose message may be reworded at any time.
    mockFetch(403, { error: 'email not verified', code: 'email_not_verified' });
    const res = await apiFetch('/v1/orgs');
    expect(res).toEqual({
      ok: false, status: 403, code: 'email_not_verified', error: 'email not verified',
    });
  });

  it('returns a failure result on 401 rather than throwing', async () => {
    // Callers branch on this to trigger the refresh redirect. A thrown error
    // would surface as a 500 page instead of a silent token rotation.
    mockFetch(401, { error: 'unauthorized' });
    const res = await apiFetch('/v1/me');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.status).toBe(401);
  });

  it('never caches an authenticated response', async () => {
    // Next caches fetches by default. A cached /v1/me would serve one user's
    // identity to another.
    const fn = mockFetch(200, {});
    await apiFetch('/v1/me', undefined, 'tok');
    expect((fn.mock.calls[0]![1] as RequestInit & { cache?: string }).cache).toBe('no-store');
  });

  it('survives a non-JSON error body without throwing', async () => {
    globalThis.fetch = vi.fn(async () => new Response('<html>502</html>', {
      status: 502, headers: { 'content-type': 'text/html' },
    })) as unknown as typeof globalThis.fetch;
    const res = await apiFetch('/v1/me');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.status).toBe(502);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
npx vitest run src/api.test.ts
```

Expected: FAIL — cannot resolve `./api.js`.

- [ ] **Step 3: Write the implementation**

`apps/web/src/api.ts`:

```ts
import { loadWebEnv } from './env.js';

export type ApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; status: number; code?: string; error: string };

/**
 * Resolves the API origin on EVERY call.
 *
 * The Dockerfile sets `API_ORIGIN=https://placeholder.invalid` at build time
 * so the build does not fail before this is wired up. Reading it at module
 * scope would capture that placeholder and bake it into any statically
 * prerendered RSC payload, which fails only in production and only silently.
 */
export function apiOrigin(): string {
  return loadWebEnv(process.env).API_ORIGIN;
}

/**
 * Server-side API call. Never throws on an HTTP error — it returns a
 * discriminated result, because callers branch on 401 (refresh) and on the
 * 403 `code` (verification), and an exception would surface as a 500 page.
 */
export async function apiFetch<T>(
  path: string,
  init?: RequestInit,
  accessToken?: string,
): Promise<ApiResult<T>> {
  const headers = new Headers(init?.headers);
  if (!headers.has('content-type') && init?.body) headers.set('content-type', 'application/json');
  if (accessToken) headers.set('authorization', `Bearer ${accessToken}`);

  let res: Response;
  try {
    res = await fetch(`${apiOrigin()}${path}`, {
      ...init,
      headers,
      // Next caches fetches by default. A cached /v1/me would serve one
      // user's identity to the next visitor.
      cache: 'no-store',
    });
  } catch (err) {
    return { ok: false, status: 0, error: err instanceof Error ? err.name : 'network error' };
  }

  const raw = await res.text();
  let parsed: unknown = undefined;
  if (raw) {
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = undefined;
    }
  }

  if (res.ok) return { ok: true, data: parsed as T };

  const body = (parsed ?? {}) as { error?: string; code?: string };
  return {
    ok: false,
    status: res.status,
    code: body.code,
    error: body.error ?? `request failed with ${res.status}`,
  };
}
```

- [ ] **Step 4: Add the contract dependency and the Dockerfile lines it requires**

`apps/web` now depends on the contract. Add to `apps/web/package.json`'s `dependencies`:

```json
    "@query-analyser/contract": "workspace:*",
```

Then `apps/web/Dockerfile`'s build stage carries a comment naming exactly the two lines to add when this happens. Add them:

```dockerfile
COPY --from=deps /app/packages/contract/node_modules ./packages/contract/node_modules
RUN pnpm --filter @query-analyser/contract build
```

Place the `COPY` beside the other two `COPY --from=deps` lines, and the `RUN` before the web build. The contract is consumed through its `dist`, which is not committed, so without this the image build fails on an unresolved module. Remove the now-stale comment that named them.

Then install from the repo root:

```bash
cd "/Users/vivekkumar/Downloads/Vivek Kumar/Projects/query-analyser" && pnpm install
```

Expect the lockfile to gain the dependency edge. If it rewrites unrelated entries, report it rather than committing the churn.

- [ ] **Step 5: Run it and watch it pass**

```bash
cd apps/web && npx vitest run src/api.test.ts
```

Expected: PASS, 7 tests.

- [ ] **Step 6: Prove the gates are load-bearing**

Three mutations, each breaking a named test. Restore with Edit after each.

1. Change `apiOrigin` to read the env once at module scope (`const ORIGIN = loadWebEnv(process.env).API_ORIGIN;` and return it). **"reads the environment on every call, never at module scope"** must FAIL.
2. Delete `cache: 'no-store'`. **"never caches an authenticated response"** must FAIL.
3. Delete `code: body.code,` from the failure result. **"surfaces the machine-readable code on a 403"** must FAIL.

- [ ] **Step 7: Full check and commit**

```bash
cd "/Users/vivekkumar/Downloads/Vivek Kumar/Projects/query-analyser"
pnpm -w run typecheck && pnpm -w run test
git add apps/web/src/api.ts apps/web/src/api.test.ts apps/web/package.json apps/web/Dockerfile pnpm-lock.yaml
git -c user.name=vivekumar08 -c user.email=vivekumar2003bsr@gmail.com commit -m "feat(web): server-side API client that returns results rather than throwing

Callers branch on a 401 to trigger refresh and on the 403 code to route to
'check your inbox', so an exception would turn both into a 500 page. The
origin is resolved per call on purpose: the Dockerfile sets a placeholder at
build time, and a module-scope read would bake it into prerendered payloads."
```

---

### Task 3: The auth route handlers

**Files:**
- Create: `apps/web/app/api/auth/login/route.ts`, `apps/web/app/api/auth/signup/route.ts`, `apps/web/app/api/auth/logout/route.ts`, `apps/web/src/forward-cookies.ts`, `apps/web/src/forward-cookies.test.ts`

**Interfaces:**
- Consumes: `SESSION_COOKIE`, `sessionCookieOptions` (Task 1); `apiFetch`, `apiOrigin` (Task 2)
- Produces: `forwardSetCookie(from: Response, to: Response): void`; three POST route handlers at `/api/auth/{login,signup,logout}`

**The subtlety that breaks everything if missed.** The browser never talks to `/v1/auth/login` directly — if it did, the access token would land in client JavaScript, which the spec forbids. So the browser posts to a **Next route handler**, which calls the API server-to-server. That means the API's `Set-Cookie: qa_refresh` comes back to *the route handler*, not to the browser. **The handler must forward it**, or the browser never receives a refresh token and every session dies after 15 minutes with no way to recover.

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/forward-cookies.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { forwardSetCookie } from './forward-cookies.js';

describe('forwardSetCookie', () => {
  it('copies the API\'s Set-Cookie onto the outgoing response', () => {
    // The browser talks to our route handler, not the API, so the API's
    // refresh cookie arrives here and dies here unless it is forwarded.
    // Without this the user gets a session that cannot be refreshed and is
    // silently logged out 15 minutes later.
    const from = new Response(null, {
      headers: { 'set-cookie': 'qa_refresh=abc; Path=/v1/auth; HttpOnly; Secure' },
    });
    const to = new Response(null);
    forwardSetCookie(from, to);
    expect(to.headers.get('set-cookie')).toContain('qa_refresh=abc');
    expect(to.headers.get('set-cookie')).toContain('Path=/v1/auth');
  });

  it('preserves the HttpOnly and Secure flags verbatim', () => {
    const from = new Response(null, {
      headers: { 'set-cookie': 'qa_refresh=abc; Path=/v1/auth; HttpOnly; Secure' },
    });
    const to = new Response(null);
    forwardSetCookie(from, to);
    const v = to.headers.get('set-cookie') ?? '';
    expect(v).toContain('HttpOnly');
    expect(v).toContain('Secure');
  });

  it('does nothing when the API set no cookie', () => {
    const to = new Response(null);
    forwardSetCookie(new Response(null), to);
    expect(to.headers.get('set-cookie')).toBeNull();
  });

  it('keeps a cookie already on the outgoing response', () => {
    // The handler sets qa_session itself before forwarding qa_refresh.
    // Overwriting rather than appending would drop one of the two.
    const from = new Response(null, { headers: { 'set-cookie': 'qa_refresh=abc; Path=/v1/auth' } });
    const to = new Response(null, { headers: { 'set-cookie': 'qa_session=xyz; Path=/' } });
    forwardSetCookie(from, to);
    const all = to.headers.getSetCookie();
    expect(all.some((c) => c.startsWith('qa_session='))).toBe(true);
    expect(all.some((c) => c.startsWith('qa_refresh='))).toBe(true);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd apps/web && npx vitest run src/forward-cookies.test.ts
```

Expected: FAIL — cannot resolve `./forward-cookies.js`.

- [ ] **Step 3: Write the helper**

`apps/web/src/forward-cookies.ts`:

```ts
/**
 * Copies every `Set-Cookie` from an API response onto an outgoing response.
 *
 * The browser posts to our route handler, which calls the API server-to-server.
 * The API's `qa_refresh` cookie therefore arrives *here* and would die here.
 * Forwarding it is what gives the browser a refresh token at all; without it
 * the session works for 15 minutes and then ends with no way to recover.
 *
 * Appends rather than sets, because the handler has usually already put
 * `qa_session` on the response and a `set` would drop it.
 */
export function forwardSetCookie(from: Response, to: Response): void {
  for (const cookie of from.headers.getSetCookie()) {
    to.headers.append('set-cookie', cookie);
  }
}
```

- [ ] **Step 4: Run it and watch it pass**

Expected: PASS, 4 tests.

- [ ] **Step 5: Write the route handlers**

`apps/web/app/api/auth/login/route.ts`:

```ts
import { NextResponse } from 'next/server';
import { SESSION_COOKIE, sessionCookieOptions } from '@/src/session';
import { apiOrigin } from '@/src/api';
import { forwardSetCookie } from '@/src/forward-cookies';

export async function POST(request: Request): Promise<Response> {
  const body = await request.text();

  const upstream = await fetch(`${apiOrigin()}/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
    cache: 'no-store',
  });

  const text = await upstream.text();
  if (!upstream.ok) {
    // Pass the API's status and body through unchanged — the login form
    // distinguishes 401 (bad credentials) from 400 (malformed).
    return new NextResponse(text, {
      status: upstream.status,
      headers: { 'content-type': 'application/json' },
    });
  }

  const { accessToken } = JSON.parse(text) as { accessToken: string };
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, accessToken, sessionCookieOptions(process.env.NODE_ENV === 'production'));
  // Must come after our own cookie: this appends the API's qa_refresh.
  forwardSetCookie(upstream, res);
  return res;
}
```

`apps/web/app/api/auth/signup/route.ts` — identical except the upstream path is `/v1/auth/signup` and success is **201**:

```ts
import { NextResponse } from 'next/server';
import { SESSION_COOKIE, sessionCookieOptions } from '@/src/session';
import { apiOrigin } from '@/src/api';
import { forwardSetCookie } from '@/src/forward-cookies';

export async function POST(request: Request): Promise<Response> {
  const body = await request.text();

  // The API awaits the verification mail before replying, which measured
  // ~3.2-3.5s live. The form must show a pending state for the whole time.
  const upstream = await fetch(`${apiOrigin()}/v1/auth/signup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
    cache: 'no-store',
  });

  const text = await upstream.text();
  if (!upstream.ok) {
    return new NextResponse(text, {
      status: upstream.status,
      headers: { 'content-type': 'application/json' },
    });
  }

  const { accessToken } = JSON.parse(text) as { accessToken: string };
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, accessToken, sessionCookieOptions(process.env.NODE_ENV === 'production'));
  forwardSetCookie(upstream, res);
  return res;
}
```

`apps/web/app/api/auth/logout/route.ts`:

```ts
import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { SESSION_COOKIE } from '@/src/session';
import { apiOrigin } from '@/src/api';
import { forwardSetCookie } from '@/src/forward-cookies';

export async function POST(): Promise<Response> {
  const jar = await cookies();
  const refresh = jar.get('qa_refresh')?.value;

  // Tell the API to revoke the refresh family. Best effort: if it fails we
  // still clear our own cookie, because a user who clicked "log out" must end
  // up logged out of this browser regardless.
  const upstream = await fetch(`${apiOrigin()}/v1/auth/logout`, {
    method: 'POST',
    headers: refresh ? { cookie: `qa_refresh=${refresh}` } : {},
    cache: 'no-store',
  }).catch(() => null);

  const res = NextResponse.json({ ok: true });
  res.cookies.delete(SESSION_COOKIE);
  if (upstream) forwardSetCookie(upstream, res);
  return res;
}
```

Note the `@/src/...` imports rely on the `paths` alias `{"@/*": ["./*"]}` already in `apps/web/tsconfig.json`.

- [ ] **Step 6: Prove the forwarding gate is load-bearing**

Delete the `forwardSetCookie(upstream, res);` line from the login handler, and confirm a test fails. If no test fails, **that is the finding** — the handlers' cookie forwarding is pinned only by the helper's own unit tests, which do not prove the handler calls it. In that case add a test that imports the login route's `POST`, stubs `fetch` to return a response carrying `set-cookie: qa_refresh=...`, and asserts the returned response's `getSetCookie()` contains both `qa_session` and `qa_refresh`. Then re-run the mutation and confirm it fails.

Report which path you took and the failing assertion.

- [ ] **Step 7: Full check and commit**

```bash
cd "/Users/vivekkumar/Downloads/Vivek Kumar/Projects/query-analyser"
cd apps/web && npx tsc --noEmit && cd ../.. && pnpm -w run test
git add apps/web/src/forward-cookies.ts apps/web/src/forward-cookies.test.ts apps/web/app/api
git -c user.name=vivekumar08 -c user.email=vivekumar2003bsr@gmail.com commit -m "feat(web): auth route handlers that keep the token off the client

The browser posts here, not to the API, so the access token never reaches
client JavaScript. The consequence is that the API's qa_refresh cookie arrives
at the handler rather than the browser and has to be forwarded explicitly —
without that the session works for fifteen minutes and then ends with no way
to recover."
```

---

### Task 4: Refresh, with the single-flight guard and exactly one retry

**Files:**
- Create: `apps/web/app/api/auth/refresh/route.ts`, `apps/web/src/auth.ts`, `apps/web/src/auth.test.ts`

**Interfaces:**
- Consumes: `singleFlight` (Task 1), `apiFetch`, `apiOrigin` (Task 2), `forwardSetCookie` (Task 3)
- Produces: `getSession(): Promise<Session | null>`, `requireSession(): Promise<Session>`, `type Session = { accessToken: string; user: { id: string; email: string; name: string; isPlatformAdmin: boolean; emailVerifiedAt: string | null } }`

**Why the retry is a redirect and not a loop.** A Server Component cannot set cookies — only route handlers and server actions can. So a 401 during a render cannot be fixed in place. The page redirects to `/api/auth/refresh?next=<path>`, the handler rotates the pair under the single-flight guard, sets both cookies, and redirects back. **The `?r=1` marker is what makes it exactly once:** if the refresh route is reached with `r=1` already set, it stops and sends the user to `/login` instead of bouncing forever.

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/auth.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const cookieStore = new Map<string, string>();
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (n: string) => (cookieStore.has(n) ? { name: n, value: cookieStore.get(n)! } : undefined),
  }),
}));

const redirectCalls: string[] = [];
vi.mock('next/navigation', () => ({
  redirect: (url: string) => { redirectCalls.push(url); throw new Error('NEXT_REDIRECT'); },
}));

import { getSession, requireSession } from './auth.js';

let originalFetch: typeof globalThis.fetch;
beforeEach(() => {
  cookieStore.clear();
  redirectCalls.length = 0;
  process.env.API_ORIGIN = 'https://api.example.com';
  originalFetch = globalThis.fetch;
});
afterEach(() => { globalThis.fetch = originalFetch; });

const meOk = () => {
  globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({
    id: 'u1', email: 'a@b.io', name: 'A', isPlatformAdmin: false, emailVerifiedAt: null,
  }), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof globalThis.fetch;
};

describe('getSession', () => {
  it('returns null when there is no session cookie, without calling the API', async () => {
    const fn = vi.fn();
    globalThis.fetch = fn as unknown as typeof globalThis.fetch;
    expect(await getSession()).toBeNull();
    expect(fn).not.toHaveBeenCalled();
  });

  it('returns the user when the session cookie is valid', async () => {
    cookieStore.set('qa_session', 'tok');
    meOk();
    const s = await getSession();
    expect(s?.user.email).toBe('a@b.io');
    expect(s?.accessToken).toBe('tok');
  });

  it('returns null when the API rejects the token', async () => {
    cookieStore.set('qa_session', 'stale');
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ error: 'unauthorized' }), {
      status: 401, headers: { 'content-type': 'application/json' },
    })) as unknown as typeof globalThis.fetch;
    expect(await getSession()).toBeNull();
  });
});

describe('requireSession', () => {
  it('redirects to /login when there is no session', async () => {
    // THE GATE. If this stops redirecting, every dashboard page renders for
    // an anonymous visitor.
    await expect(requireSession()).rejects.toThrow('NEXT_REDIRECT');
    expect(redirectCalls[0]).toBe('/login');
  });

  it('returns the session when one exists', async () => {
    cookieStore.set('qa_session', 'tok');
    meOk();
    const s = await requireSession();
    expect(s.user.id).toBe('u1');
    expect(redirectCalls).toHaveLength(0);
  });

  it('never puts the access token in the returned user object', async () => {
    // The user object is what pages pass to client components. If the token
    // rode along inside it, it would be serialised into the RSC payload and
    // end up readable in the browser — defeating the httpOnly cookie.
    cookieStore.set('qa_session', 'tok');
    meOk();
    const s = await requireSession();
    expect(JSON.stringify(s.user)).not.toContain('tok');
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd apps/web && npx vitest run src/auth.test.ts
```

Expected: FAIL — cannot resolve `./auth.js`.

- [ ] **Step 3: Write the data-layer gate**

`apps/web/src/auth.ts`:

```ts
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { SESSION_COOKIE } from './session.js';
import { apiFetch } from './api.js';

export interface Session {
  accessToken: string;
  user: {
    id: string;
    email: string;
    name: string;
    isPlatformAdmin: boolean;
    emailVerifiedAt: string | null;
  };
}

/**
 * Reads the session, or null.
 *
 * This is the real gate, not `proxy.ts`. Next 16's docs are explicit that a
 * matcher change or moving a Server Function to another route can silently
 * remove proxy coverage, and that auth must be checked in the data layer
 * rather than relying on proxy alone.
 */
export async function getSession(): Promise<Session | null> {
  const jar = await cookies();
  const accessToken = jar.get(SESSION_COOKIE)?.value;
  if (!accessToken) return null;

  const res = await apiFetch<Session['user']>('/v1/me', undefined, accessToken);
  if (!res.ok) return null;

  return { accessToken, user: res.data };
}

/** Same, but sends an anonymous visitor to the login page. */
export async function requireSession(): Promise<Session> {
  const session = await getSession();
  if (!session) redirect('/login');
  return session;
}
```

- [ ] **Step 4: Write the refresh route handler**

`apps/web/app/api/auth/refresh/route.ts`:

```ts
import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { SESSION_COOKIE, sessionCookieOptions } from '@/src/session';
import { apiOrigin } from '@/src/api';
import { forwardSetCookie } from '@/src/forward-cookies';
import { singleFlight } from '@/src/single-flight';

/**
 * Module-scope so concurrent requests share it. This is a route handler, not
 * proxy.ts — Next's docs say proxy must not rely on shared modules or globals,
 * which is exactly why the refresh lives here.
 */
const run = singleFlight<Response>();

/** Only same-origin absolute paths, so `?next=` cannot be an open redirect. */
function safeNext(raw: string | null): string {
  if (!raw || !raw.startsWith('/') || raw.startsWith('//')) return '/';
  return raw;
}

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const next = safeNext(url.searchParams.get('next'));

  // EXACTLY ONCE. Arriving here with r=1 means a refresh already happened for
  // this navigation and the retry still failed, so stop rather than bounce.
  if (url.searchParams.get('r') === '1') {
    return NextResponse.redirect(new URL('/login', url.origin));
  }

  const jar = await cookies();
  const refresh = jar.get('qa_refresh')?.value;
  if (!refresh) return NextResponse.redirect(new URL('/login', url.origin));

  // Keyed on the refresh token: concurrent renders carrying the SAME token
  // must collapse into one rotation, or the API's family-revocation sees a
  // replay and logs the user out of everything.
  const upstream = await run(refresh, () =>
    fetch(`${apiOrigin()}/v1/auth/refresh`, {
      method: 'POST',
      headers: { cookie: `qa_refresh=${refresh}` },
      cache: 'no-store',
    }),
  );

  if (!upstream.ok) return NextResponse.redirect(new URL('/login', url.origin));

  // `clone()` because the single-flight guard hands the same Response object
  // to every concurrent caller, and a body can only be read once.
  const { accessToken } = (await upstream.clone().json()) as { accessToken: string };

  const retry = new URL(next, url.origin);
  retry.searchParams.set('r', '1');
  const res = NextResponse.redirect(retry);
  res.cookies.set(SESSION_COOKIE, accessToken, sessionCookieOptions(process.env.NODE_ENV === 'production'));
  forwardSetCookie(upstream, res);
  return res;
}
```

- [ ] **Step 5: Run the tests and watch them pass**

```bash
npx vitest run src/auth.test.ts
```

Expected: PASS, 6 tests.

- [ ] **Step 6: Prove the gate is load-bearing — the spec requires this one explicitly**

1. In `requireSession`, delete the `if (!session) redirect('/login');` line (return a cast instead). **"redirects to /login when there is no session"** must FAIL. Restore.
2. In `getSession`, change `if (!res.ok) return null;` to ignore the result and return a session anyway. **"returns null when the API rejects the token"** must FAIL. Restore.
3. In `auth.ts`, add `accessToken` into the returned `user` object. **"never puts the access token in the returned user object"** must FAIL. Restore.

Report each failing test and its assertion message.

- [ ] **Step 7: Full check and commit**

```bash
cd apps/web && npx tsc --noEmit && cd ../.. && pnpm -w run test
git add apps/web/src/auth.ts apps/web/src/auth.test.ts apps/web/app/api/auth/refresh
git -c user.name=vivekumar08 -c user.email=vivekumar2003bsr@gmail.com commit -m "feat(web): serialised refresh and the data-layer session gate

A Server Component cannot set cookies, so a 401 during render cannot be fixed
in place — the page redirects to a route handler that rotates the pair and
bounces back. The r=1 marker is what makes that exactly once rather than a
loop. The refresh is keyed on the refresh token under a single-flight guard
because the API revokes the whole family on replay.

The gate lives in the data layer, not in proxy.ts: Next's own docs warn that a
matcher change or moving a Server Function can silently remove proxy coverage."
```

---

### Task 5: Route guards, auth screens, and the email-link screens

**Files:**
- Create: `apps/web/proxy.ts`, `apps/web/app/login/page.tsx`, `apps/web/app/signup/page.tsx`, `apps/web/app/verify/page.tsx`, `apps/web/app/reset-password/page.tsx`, `apps/web/app/_components/AuthForm.tsx`, `apps/web/src/proxy.test.ts`

**Interfaces:**
- Consumes: `SESSION_COOKIE` (Task 1), the route handlers (Task 3)
- Produces: `proxy(request)` and its `config.matcher`

**Why `/verify` and `/reset-password` are in this plan.** The email phase's links point at `${WEB_ORIGIN}/verify?token=...` and `/reset-password?token=...`. Those pages do not exist, which is why verification is currently operator-assisted and `apps/api/README.md` documents a manual `POST`. Building them here removes that step. **The token must be POSTed, never GET** — the API's confirm endpoints are POST-with-body precisely because Fastify logs `req.url`, and an invite token leaked that way in this project once.

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/proxy.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { unstable_doesProxyMatch } from 'next/experimental/testing/server';
import { config } from '../proxy.js';

describe('proxy matcher', () => {
  it('runs on dashboard routes', () => {
    expect(unstable_doesProxyMatch({ config, nextConfig: {}, url: '/dashboard' })).toBe(true);
  });

  it('does not run on the public pages', () => {
    // If the matcher caught these, an anonymous visitor would be redirected
    // away from the login page they were just sent to — an infinite bounce.
    for (const url of ['/', '/login', '/signup', '/verify', '/reset-password']) {
      expect(unstable_doesProxyMatch({ config, nextConfig: {}, url })).toBe(false);
    }
  });

  it('does not run on static assets or the auth route handlers', () => {
    for (const url of ['/_next/static/chunk.js', '/api/auth/login', '/favicon.ico']) {
      expect(unstable_doesProxyMatch({ config, nextConfig: {}, url })).toBe(false);
    }
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd apps/web && npx vitest run src/proxy.test.ts
```

Expected: FAIL — cannot resolve `../proxy.js`.

- [ ] **Step 3: Write `proxy.ts`**

```ts
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { SESSION_COOKIE } from './src/session.js';

/**
 * Redirect UX only. This is NOT the security gate.
 *
 * Next 16's docs warn that a matcher change, or moving a Server Function to a
 * different route, silently removes proxy coverage — and that auth must be
 * verified in the data layer regardless. `requireSession()` in src/auth.ts is
 * the real gate; this exists so an anonymous visitor gets a clean redirect
 * instead of a render that redirects.
 */
export function proxy(request: NextRequest): NextResponse {
  if (request.cookies.has(SESSION_COOKIE)) return NextResponse.next();

  const login = new URL('/login', request.url);
  login.searchParams.set('next', request.nextUrl.pathname);
  return NextResponse.redirect(login);
}

export const config = {
  matcher: [
    // Everything except the public pages, the auth route handlers, Next's own
    // assets and metadata files. The negative lookahead is the documented
    // pattern; without it the proxy runs on CSS and JS too and blocks them.
    '/((?!api|_next/static|_next/image|favicon.ico|robots.txt|sitemap.xml|login|signup|verify|reset-password|$).*)',
  ],
};
```

- [ ] **Step 4: Write the shared auth form**

`apps/web/app/_components/AuthForm.tsx` — a client component, because it owns form state:

```tsx
'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

interface Props {
  mode: 'login' | 'signup';
  next: string;
}

export function AuthForm({ mode, next }: Props) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setPending(true);
    setError(null);

    const form = new FormData(e.currentTarget);
    const payload: Record<string, string> = {
      email: String(form.get('email') ?? ''),
      password: String(form.get('password') ?? ''),
    };
    if (mode === 'signup') payload.name = String(form.get('name') ?? '');

    const res = await fetch(`/api/auth/${mode}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      setError(body.error ?? 'Something went wrong. Try again.');
      setPending(false);
      return;
    }

    router.push(next);
    router.refresh();
  }

  return (
    <form onSubmit={onSubmit} className="flex w-full max-w-sm flex-col gap-4">
      {mode === 'signup' && (
        <label className="flex flex-col gap-1">
          <span className="text-sm font-medium">Name</span>
          <input name="name" required maxLength={100}
            className="rounded-md border border-slate-300 px-3 py-2" />
        </label>
      )}
      <label className="flex flex-col gap-1">
        <span className="text-sm font-medium">Email</span>
        <input name="email" type="email" required autoComplete="email"
          className="rounded-md border border-slate-300 px-3 py-2" />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-sm font-medium">Password</span>
        <input name="password" type="password" required minLength={12}
          autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
          className="rounded-md border border-slate-300 px-3 py-2" />
        {mode === 'signup' && (
          <span className="text-xs text-slate-500">At least 12 characters.</span>
        )}
      </label>

      {error && <p role="alert" className="text-sm text-red-600">{error}</p>}

      <button type="submit" disabled={pending}
        className="rounded-md bg-slate-900 px-4 py-2 text-white disabled:opacity-60">
        {pending
          ? (mode === 'signup' ? 'Creating your account…' : 'Signing in…')
          : (mode === 'signup' ? 'Create account' : 'Sign in')}
      </button>

      {mode === 'signup' && (
        // Signup measured 3.2-3.5s live because the API awaits the
        // verification mail. Saying so is the difference between a slow form
        // and a form that looks broken.
        <p className="text-xs text-slate-500">
          This takes a few seconds — we send your verification email before confirming.
        </p>
      )}
    </form>
  );
}
```

- [ ] **Step 5: Write the four pages**

`apps/web/app/login/page.tsx`:

```tsx
import Link from 'next/link';
import { AuthForm } from '../_components/AuthForm';

export default async function LoginPage({
  searchParams,
}: { searchParams: Promise<{ next?: string }> }) {
  const { next } = await searchParams;
  const target = next && next.startsWith('/') && !next.startsWith('//') ? next : '/dashboard';

  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-6 px-4">
      <h1 className="text-2xl font-semibold">Sign in</h1>
      <AuthForm mode="login" next={target} />
      <p className="text-sm text-slate-600">
        No account? <Link href="/signup" className="underline">Create one</Link>
      </p>
    </main>
  );
}
```

`apps/web/app/signup/page.tsx`:

```tsx
import Link from 'next/link';
import { AuthForm } from '../_components/AuthForm';

export default function SignupPage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-6 px-4">
      <h1 className="text-2xl font-semibold">Create your account</h1>
      <p className="text-sm text-slate-600">
        We&apos;ll email you a link to confirm your address. You&apos;ll need it before
        your ingest key appears.
      </p>
      <AuthForm mode="signup" next="/dashboard" />
      <p className="text-sm text-slate-600">
        Already have an account? <Link href="/login" className="underline">Sign in</Link>
      </p>
    </main>
  );
}
```

`apps/web/app/verify/page.tsx` — the page the verification email links to:

```tsx
import { VerifyClient } from '../_components/VerifyClient';

export default async function VerifyPage({
  searchParams,
}: { searchParams: Promise<{ token?: string }> }) {
  const { token } = await searchParams;

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-4 px-4">
      <h1 className="text-2xl font-semibold">Confirm your email</h1>
      {token
        ? <VerifyClient token={token} />
        : <p className="text-slate-600">This link is missing its token. Use the link from your email.</p>}
    </main>
  );
}
```

`apps/web/app/_components/VerifyClient.tsx` — POSTs the token rather than letting it sit in a URL the API would log:

```tsx
'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';

export function VerifyClient({ token }: { token: string }) {
  const [state, setState] = useState<'pending' | 'done' | 'failed'>('pending');

  useEffect(() => {
    let cancelled = false;
    // POST, never GET. The API's confirm endpoints take the token in a body
    // because Fastify logs req.url — an invite token leaked exactly that way
    // in this project once.
    fetch('/api/auth/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token }),
    })
      .then((r) => { if (!cancelled) setState(r.ok ? 'done' : 'failed'); })
      .catch(() => { if (!cancelled) setState('failed'); });
    return () => { cancelled = true; };
  }, [token]);

  if (state === 'pending') return <p className="text-slate-600">Confirming…</p>;
  if (state === 'done') {
    return (
      <>
        <p className="text-slate-800">Your email is confirmed.</p>
        <Link href="/dashboard" className="underline">Go to your dashboard</Link>
      </>
    );
  }
  return (
    <>
      <p className="text-slate-800">That link didn&apos;t work — it may have expired or already been used.</p>
      <Link href="/login" className="underline">Sign in to request a new one</Link>
    </>
  );
}
```

Add the matching route handler `apps/web/app/api/auth/verify/route.ts`:

```ts
import { NextResponse } from 'next/server';
import { apiOrigin } from '@/src/api';

export async function POST(request: Request): Promise<Response> {
  const body = await request.text();
  const upstream = await fetch(`${apiOrigin()}/v1/auth/verify/confirm`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
    cache: 'no-store',
  });
  return new NextResponse(await upstream.text(), {
    status: upstream.status,
    headers: { 'content-type': 'application/json' },
  });
}
```

`apps/web/app/reset-password/page.tsx`:

```tsx
import { ResetClient } from '../_components/ResetClient';

export default async function ResetPasswordPage({
  searchParams,
}: { searchParams: Promise<{ token?: string }> }) {
  const { token } = await searchParams;

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-4 px-4">
      <h1 className="text-2xl font-semibold">Choose a new password</h1>
      {token
        ? <ResetClient token={token} />
        : <p className="text-slate-600">This link is missing its token. Use the link from your email.</p>}
    </main>
  );
}
```

`apps/web/app/_components/ResetClient.tsx`:

```tsx
'use client';

import { useState } from 'react';
import Link from 'next/link';

export function ResetClient({ token }: { token: string }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setPending(true);
    setError(null);

    const form = new FormData(e.currentTarget);
    // POST, never GET — same reason as the verify page: the API takes the
    // token in a body because Fastify logs req.url.
    const res = await fetch('/api/auth/reset', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token, password: String(form.get('password') ?? '') }),
    });

    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      setError(body.error ?? 'That link didn\u2019t work \u2014 it may have expired or already been used.');
      setPending(false);
      return;
    }
    setDone(true);
  }

  if (done) {
    return (
      <>
        <p className="text-slate-800">
          Your password is changed. Every other session has been signed out.
        </p>
        <Link href="/login" className="underline">Sign in</Link>
      </>
    );
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4">
      <label className="flex flex-col gap-1">
        <span className="text-sm font-medium">New password</span>
        <input name="password" type="password" required minLength={12}
          autoComplete="new-password"
          className="rounded-md border border-slate-300 px-3 py-2" />
        <span className="text-xs text-slate-500">At least 12 characters.</span>
      </label>

      {error && <p role="alert" className="text-sm text-red-600">{error}</p>}

      <button type="submit" disabled={pending}
        className="rounded-md bg-slate-900 px-4 py-2 text-white disabled:opacity-60">
        {pending ? 'Saving\u2026' : 'Set new password'}
      </button>
    </form>
  );
}
```

`apps/web/app/api/auth/reset/route.ts`:

```ts
import { NextResponse } from 'next/server';
import { apiOrigin } from '@/src/api';

export async function POST(request: Request): Promise<Response> {
  const body = await request.text();
  const upstream = await fetch(`${apiOrigin()}/v1/auth/password/confirm`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
    cache: 'no-store',
  });
  return new NextResponse(await upstream.text(), {
    status: upstream.status,
    headers: { 'content-type': 'application/json' },
  });
}
```

The `minLength={12}` and its hint are not decoration: `resetSchema` in `apps/api/src/auth/routes.ts:13-16` is `{ token: string().min(1).max(200), password: string().min(12).max(200) }`, so a shorter password returns a 400 the user cannot otherwise explain. The "every other session has been signed out" copy is accurate — `password/confirm` revokes the user's entire refresh-token family.

- [ ] **Step 6: Run the tests and prove the guard**

```bash
npx vitest run src/proxy.test.ts
```

Expected: PASS, 3 tests.

Then the mutation: change the matcher to also exclude `/dashboard` (add `|dashboard` to the negative lookahead). **"runs on dashboard routes"** must FAIL. Restore.

Note that `requireSession()`'s own gate test from Task 4 is the one that matters for security — the proxy test only pins the redirect UX. Both exist because the proxy can be silently bypassed and the data layer cannot.

- [ ] **Step 7: Full check and commit**

```bash
cd apps/web && npx tsc --noEmit && cd ../.. && pnpm -w run test
git add apps/web/proxy.ts apps/web/src/proxy.test.ts apps/web/app/login apps/web/app/signup apps/web/app/verify apps/web/app/reset-password apps/web/app/_components apps/web/app/api/auth/verify apps/web/app/api/auth/reset
git -c user.name=vivekumar08 -c user.email=vivekumar2003bsr@gmail.com commit -m "feat(web): auth screens, route guards, and the pages the email links point at

/verify and /reset-password are what remove the operator-assisted step the API
README currently documents: the emailed link lands on a page that POSTs the
token, never a GET, because the API's confirm endpoints take it in a body
precisely so Fastify's request logging cannot capture it.

proxy.ts is redirect UX, not the gate. Next's docs warn that proxy coverage
disappears silently when a matcher changes or a Server Function moves, so
requireSession() in the data layer is what actually protects a route."
```

---

### Task 6: The landing page

**Files:**
- Modify: `apps/web/app/page.tsx`, `apps/web/package.json` (add `framer-motion`)
- Create: `apps/web/app/_components/landing/Hero.tsx`, `CopyButton.tsx`, `Captured.tsx`, `Privacy.tsx`, `Plans.tsx`, `FadeIn.tsx`

**Interfaces:**
- Consumes: nothing from earlier tasks — the landing page is public and session-free.
- Produces: the shareable public page.

**The hero is the install snippet.** The product's claim is that it takes one line, so the line is the first thing on the page. An animation-heavy hero argues against the copy next to it, which is why the amendment rejected Animaster. Keep Motion components as **leaves**: each `'use client'` component wraps only its own content, so the page stays server-rendered around them.

- [ ] **Step 1: Add Motion**

```bash
cd "/Users/vivekkumar/Downloads/Vivek Kumar/Projects/query-analyser/apps/web"
npm pkg set dependencies.framer-motion="^14.1.0"
cd ../.. && pnpm install
```

`framer-motion` is MIT. Any component copied from Vengeance UI (also MIT) keeps a header comment naming its source and licence. **No paid component source may be committed** — the repo is public.

- [ ] **Step 2: Write the reduced-motion-aware animation leaf**

`apps/web/app/_components/landing/FadeIn.tsx`:

```tsx
'use client';

import { motion, useReducedMotion } from 'framer-motion';
import type { ReactNode } from 'react';

/**
 * The only animated primitive on the landing page.
 *
 * A leaf on purpose: it wraps its children and nothing else, so the sections
 * around it stay server-rendered. Hoisting 'use client' to a section would
 * pull that whole subtree into the client bundle.
 *
 * Honours prefers-reduced-motion — for some people motion is a vestibular
 * trigger, not a preference.
 */
export function FadeIn({ children, delay = 0 }: { children: ReactNode; delay?: number }) {
  const reduced = useReducedMotion();
  if (reduced) return <>{children}</>;

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: '-64px' }}
      transition={{ duration: 0.4, delay, ease: 'easeOut' }}
    >
      {children}
    </motion.div>
  );
}
```

- [ ] **Step 3: Write the copy-to-clipboard button**

`apps/web/app/_components/landing/CopyButton.tsx`:

```tsx
'use client';

import { useState } from 'react';

export function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        } catch {
          // Clipboard access can be denied; the snippet is selectable anyway.
          setCopied(false);
        }
      }}
      className="rounded-md border border-slate-700 px-3 py-1 text-xs text-slate-300 hover:bg-slate-800"
      aria-label="Copy the install command"
    >
      {copied ? 'Copied' : 'Copy'}
    </button>
  );
}
```

- [ ] **Step 4: Write the page**

Replace `apps/web/app/page.tsx` entirely:

```tsx
import Link from 'next/link';
import { FadeIn } from './_components/landing/FadeIn';
import { CopyButton } from './_components/landing/CopyButton';

const INSTALL = 'npm i @vivekumar08/query-analyser';

export default function Page() {
  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-20 px-4 py-20">
      <section className="flex flex-col gap-6">
        <h1 className="text-4xl font-semibold tracking-tight">
          Find the queries costing you the most time.
        </h1>
        <p className="text-lg text-slate-600">
          One line in your app. Query Analyser watches your database calls, groups them
          by shape, and tells you which ones to fix first.
        </p>

        <div className="flex items-center justify-between gap-4 rounded-lg bg-slate-900 px-4 py-3">
          <code className="font-mono text-sm text-slate-100">{INSTALL}</code>
          <CopyButton text={INSTALL} />
        </div>

        <div className="flex items-center gap-4">
          <Link href="/signup"
            className="rounded-md bg-slate-900 px-5 py-2.5 text-white">
            Get your ingest key
          </Link>
          <span className="text-sm text-slate-500">
            Free while in beta. Email confirmation required.
          </span>
        </div>
      </section>

      <FadeIn>
        <section className="flex flex-col gap-4">
          <h2 className="text-2xl font-semibold">What gets captured</h2>
          <ul className="flex flex-col gap-2 text-slate-600">
            <li>The query shape — model, operation, filter keys, sort keys.</li>
            <li>How often it runs, how long it takes, and the slowest observation.</li>
            <li>A latency histogram, so p95 and p99 are honest rather than guessed.</li>
            <li>One redacted sample per shape, to make a slow query recognisable.</li>
          </ul>
        </section>
      </FadeIn>

      <FadeIn delay={0.05}>
        <section className="flex flex-col gap-4">
          <h2 className="text-2xl font-semibold">What never leaves your app</h2>
          <p className="text-slate-600">
            Query values are redacted before anything is sent. We store the shape of a
            query and its timings — never the data it matched, and never the rows it
            returned. The sample you see in the dashboard has had its values removed in
            your process, before the network call.
          </p>
        </section>
      </FadeIn>

      <FadeIn delay={0.1}>
        <section className="flex flex-col gap-4">
          <h2 className="text-2xl font-semibold">Plans</h2>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="rounded-lg border border-slate-200 p-5">
              <h3 className="font-medium">Free</h3>
              <p className="mt-2 text-sm text-slate-600">
                One app, seven days of history. Everything the dashboard shows.
              </p>
            </div>
            <div className="rounded-lg border border-slate-200 p-5">
              <h3 className="font-medium">Team</h3>
              <p className="mt-2 text-sm text-slate-600">
                Coming soon — longer retention, more apps, and alerting.
              </p>
            </div>
          </div>
        </section>
      </FadeIn>

      <footer className="border-t border-slate-200 pt-8 text-sm text-slate-500">
        <Link href="/login" className="underline">Sign in</Link>
      </footer>
    </main>
  );
}
```

Note what this page deliberately does **not** have: a screenshot. The spec lists one, but there is no dashboard to screenshot until Plan C. A fabricated screenshot of a product that does not exist yet would be a lie on the public page. Add it in Plan C, from the real thing.

- [ ] **Step 5: Verify the client boundary holds**

The point of keeping Motion at the leaves is that the page stays server-rendered. Prove it:

```bash
cd "/Users/vivekkumar/Downloads/Vivek Kumar/Projects/query-analyser/apps/web"
API_ORIGIN=https://prod-query-analyser.dhql6p.easypanel.host npx next build
```

Then confirm the landing route is **not** marked as a client-heavy route and that `page.tsx` itself carries no `'use client'`:

```bash
grep -L "use client" app/page.tsx && echo "page.tsx is a server component: OK"
grep -l "use client" app/_components/landing/*.tsx
```

Expected: `page.tsx` has no `'use client'`; only `FadeIn.tsx` and `CopyButton.tsx` do.

- [ ] **Step 6: Full check and commit**

```bash
cd "/Users/vivekkumar/Downloads/Vivek Kumar/Projects/query-analyser"
pnpm -w run typecheck && pnpm -w run test
git add apps/web/app apps/web/package.json pnpm-lock.yaml
git -c user.name=vivekumar08 -c user.email=vivekumar2003bsr@gmail.com commit -m "feat(web): the landing page

The install snippet is the hero because the product's claim is that it takes
one line — anything louder above it argues with the copy. Motion stays at the
leaves so the sections around it remain server-rendered, and FadeIn returns
its children unwrapped under prefers-reduced-motion.

No screenshot: the spec asks for one, but there is no dashboard to photograph
until Plan C, and a mocked-up screenshot of a product that does not exist yet
would be a lie on a public page."
```

---

## Self-Review

**Spec coverage (steps 3–4 only)**

| Spec requirement | Task |
|---|---|
| Access token in an httpOnly session cookie the web app sets itself | 1, 3 |
| Read server-side, never reaching client JavaScript | 4 (test 3 pins it) |
| On a 401, a route handler refreshes and retries **once** | 4 (`?r=1`) |
| Refresh serialised with a single-flight guard | 1, 4 |
| Client components never hold a token | 3, 4 |
| Route guards | 5 (proxy) + 4 (`requireSession`, the real gate) |
| Login / signup screens | 5 |
| Verify and reset-password screens the email links point at | 5 |
| Landing hero is the install snippet | 6 |
| What gets captured, privacy statement, plan placeholders, signup CTA | 6 |
| Home copy sets the expectation of email verification | 6 ("Email confirmation required"), 5 (signup page) |
| One animation runtime, Motion only | 6 |
| `prefers-reduced-motion` respected | 6 (`FadeIn`) |
| Motion components as leaves, not whole-page client bundles | 6 (Step 5 verifies) |
| No paid component source committed | Global constraint; nothing vendored in this plan |
| Mutation-checkable tests on pure helpers | 1 (4 mutations), 2 (3), 4 (3), 5 (1) |
| Two auth tests that fail when the guard is removed | 4 Step 6 (gate + token-leak) |
| No Playwright | Nothing added |

**Deliberately deferred to Plan C:** the screenshot (no dashboard exists to photograph), `/dashboard` itself, and the onboarding flow. `proxy.ts` redirects `/dashboard` to `/login` today, and `requireSession()` is ready for the page Plan C adds.

**Placeholder scan:** one found and fixed. Task 5 Step 5 originally described the reset-password page, its client component and its route handler as "identical in shape" to the verify trio rather than writing them. That is precisely the "Similar to Task N" failure this skill forbids — an implementer reading tasks out of order would have had to infer three files from a sibling. All three are now written out in full. The install snippet's package name was verified against `packages/sdk/package.json` (`@vivekumar08/query-analyser`) rather than recalled, and the reset form's `minLength={12}` against `resetSchema` in `apps/api/src/auth/routes.ts:13-16`.

**Type consistency:** `Session` (Task 4) is the only shared shape, and its `user` matches `GET /v1/me`'s documented response including `emailVerifiedAt: string | null`. `ApiResult<T>` (Task 2) is consumed by `getSession` with the discriminant checked before `.data` is read. `SESSION_COOKIE` and `sessionCookieOptions` (Task 1) are used by name in Tasks 3, 4 and 5. `forwardSetCookie` (Task 3) is used in Task 4. `singleFlight` (Task 1) is used in Task 4 with the `<Response>` type argument.

**Three things I settled that the spec left open**

**The refresh retry is a redirect, not an in-place retry.** The spec says "a route handler calls `/v1/auth/refresh`, rotates the cookie pair, and retries once", which reads like a retry inside the fetch. It cannot be: a Server Component cannot set cookies, so a 401 mid-render has nowhere to put the rotated pair. The redirect to `/api/auth/refresh?next=…&r=1` is the only shape that both rotates cookies and honours "once" — and the `r=1` marker is what stops it looping when refresh itself keeps failing.

**The gate is in the data layer, not the proxy.** Next 16's docs state plainly that a matcher change or moving a Server Function silently removes proxy coverage, and that authorization must be verified in the Server Function rather than relying on proxy alone. So `requireSession()` is the gate and `proxy.ts` is redirect UX. Both are tested, but only the data-layer test is a security gate.

**The single-flight guard is per-process, and that is stated rather than hidden.** It collapses concurrent refreshes inside one Node process. With more than one web replica, two instances could still race and trip the API's family revocation. The deployment runs a single replica so it is effective today; `single-flight.ts` says so in its own docblock, so whoever scales the service finds the caveat at the code rather than in a plan nobody re-reads.
