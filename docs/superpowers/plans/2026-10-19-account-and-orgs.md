# Account Page, Own Organisations and Role-Correct App Creation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let anyone create and switch between their own organisations, give every user an Account page (name, password, organisations), and make app creation ADMIN+ in the API and the UI.

**Architecture:**
- The API gains `PATCH /v1/me`, `POST /v1/me/password` and `DELETE /v1/orgs/:org/membership`. App creation moves to ADMIN+, `account` and `new` become reserved slugs, and invite accept returns the org slug.
- The web gets a new `/dashboard/[org]` route (it redirects into an app, or shows an org home in a bare Mist shell) and a static `/dashboard/account` page in the same shell. It also gets three BFF routes, role-aware landing and onboarding logic, and a switcher that lists organisations.
- `getShellContext` and the app sidebar are not refactored. New screens sit outside the `[org]/[app]` layout.

**Tech Stack:** TypeScript, Fastify 5 + Prisma 7 (Postgres), zod, argon2, Next 16 App Router, React 19, cmdk, radix AlertDialog, Vitest + Testing Library.

**Spec:** `docs/superpowers/specs/2026-10-19-account-and-orgs-design.md`. Read it; it is the authority. Its "controller's call" items are decided.

## Global Constraints

- No new dependencies. No schema migration: everything uses existing columns.
- App creation (`POST /v1/orgs/:org/apps`) is **ADMIN+**. MEMBER/VIEWER get 403.
- `PATCH /v1/me` body `{ name }`: trimmed, **1–100** chars. Returns the same shape as `GET /v1/me`. Unknown fields are ignored.
- `POST /v1/me/password`: rate-limited **10/min**. `newPassword` is **12–200** chars. Wrong current password → **403 `{ error: 'wrong-password' }`**. New equal to current → **400**. On success, revoke **every** refresh token for the user, then issue a fresh session exactly as login does (same body shape, sets `qa_refresh`).
- Leaving as the last OWNER → **409 `{ error: 'organization must keep at least one owner' }`**, under the same `FOR UPDATE` lock as member removal. 204 on success.
- Reserved org slugs: **`account`, `new`**. They get the random suffix, as a taken slug does. Existing rows aren't migrated. If one exists in production, say so in the PR description.
- Web copy, verbatim from the spec:
  - "No apps yet. Ask an admin to connect one."
  - "Create your own organisation"
  - "Connect your first app"
  - "← Back to dashboard"
  - "Other devices are signed out within 15 minutes."
  - "You're the only owner. Make someone else an owner first."
- Web hrefs: new organisation is `/onboarding?new=org`. Account is `/dashboard/account`. Every org link is `/dashboard/<slug>`. New app is `/onboarding?org=<slug>`.
- BFF handlers: `gate(request, true)` from `src/org-bff.ts` (that is `rejectCrossSiteAuthPost` then `sessionOr401`), then path params through `isSafeSegment`, then bodies forwarded as explicit allowlists. Every response is `cache-control: no-store`.
- Mist styling: glass, pills, `text-accent-text` for accent text, never `text-chart-1` or the ink `text-primary`.
- Component tests: first line `// @vitest-environment jsdom`, and `afterEach(cleanup)`.
- Accessibility: every input has a label, results go in `role="status"` / `role="alert"` live regions, and focus moves to the list heading after a row unmounts. `Members.tsx` is the reference.
- Commits: conventional (`feat(api): …`, `feat(web): …`), **no co-author trailers**. Never push.
- Every existing test stays green. API tests need `pnpm --filter @query-analyser/api db:generate` first, and Postgres via `DATABASE_URL`.

## Review Focus

- **Rate limit through the BFF:** the password BFF must forward the browser's IP (`upstreamAuthHeaders`) to `/v1/me/password`. Otherwise the 10/min limit becomes one bucket shared by every user of the web server. Pinned in Task 7.
- **Session cookies after a password change:** the BFF must set `qa_session` and the rescoped `qa_refresh` (`Path=/api/auth`). Its JSON body must never contain the access token, so it never reaches client JS. Pinned in Task 7.
- **Another device refreshing after the change:** an old refresh token replayed after the password change revokes only its own family. This device's new session keeps refreshing. Pinned in Task 2.
- **Suspended org with no reachable apps:** `/dashboard` can land on `/dashboard/<slug>` for an org whose app list 403s. That page must say the organisation is suspended. It must not crash, 404 or loop. Pinned in Task 5.
- **Reloading `/onboarding?new=org` after the org was created:** the reload must not offer to create a second org. The flow rewrites the URL to `?org=<slug>` once the org exists. Pinned in Task 4.

---

## File Structure

**API (`apps/api/src`)**
- `apps/routes.ts`: app create becomes `requireRole('ADMIN')`.
- `orgs/routes.ts`: `RESERVED_SLUGS`, plus the new `DELETE /v1/orgs/:org/membership` beside member removal (it reuses `LastOwnerError`).
- `orgs/invites.ts`: the accept response adds `slug`.
- `auth/routes.ts`: `PATCH /v1/me` and `POST /v1/me/password` beside `GET /v1/me`. They reuse `issue()`.
- Tests: `apps/routes.test.ts`, `orgs/routes.test.ts`, `orgs/invites.test.ts`, and a new `auth/me.test.ts`. The new file gets its own app instance, so its rate-limit buckets don't touch `auth.test.ts`'s signups.

**Web (`apps/web`)**
- `src/landing.ts`: the `'org'` landing, `orgPath`, `resolveOrgLanding`, `NEW_ORG_HREF`, `ACCOUNT_HREF`.
- `src/dashboard-types.ts`: `ROLE_LABEL`, `isAdminRole`.
- `src/onboarding-state.ts`, `app/onboarding/page.tsx`, `components/onboarding/OnboardingFlow.tsx`: role awareness and `new=org`.
- `app/dashboard/page.tsx`: the new landing kind.
- `components/dashboard/BareShell.tsx`: the Mist shell without the sidebar. Shared by the org home and Account.
- `components/dashboard/OrgHome.tsx` and `app/dashboard/[org]/page.tsx`: the org route.
- `app/api/invites/accept/route.ts` and `app/_components/AcceptInviteClient.tsx`: the slug and the redirect.
- `components/dashboard/switcher.ts`, `AppSwitcher.tsx`, `Sidebar.tsx` (`SidebarAccount`), `app/dashboard/[org]/[app]/layout.tsx`.
- `app/api/me/route.ts`, `app/api/me/password/route.ts`, `app/api/orgs/[org]/membership/route.ts`, with tests in `src/account-routes.test.ts`.
- `app/dashboard/account/page.tsx` and `components/account/{ProfileCard,PasswordCard,OrganisationsCard}.tsx`, each with a colocated test.

---

### Task 1: API — ADMIN+ app creation, reserved slugs, slug in invite accept

**Files:**
- Modify: `apps/api/src/apps/routes.ts` (the `app.post('/v1/orgs/:org/apps'` preHandler)
- Modify: `apps/api/src/orgs/routes.ts` (`POST /v1/orgs`'s `taken` check)
- Modify: `apps/api/src/orgs/invites.ts` (the accept route's `findUnique` include and its return value)
- Test: `apps/api/src/apps/routes.test.ts`, `apps/api/src/orgs/routes.test.ts`, `apps/api/src/orgs/invites.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `POST /v1/invites/:token/accept` → `200 { orgId: string; slug: string; role: Role }` (Task 5's BFF reads `slug`). `POST /v1/orgs/:org/apps` → 403 `{ error: 'insufficient role' }` below ADMIN.

- [ ] **Step 1: Write the failing tests**

In `apps/routes.test.ts` `describe('apps')`, copy the setup of the existing `'403s a VIEWER attempting to create an app'` test. Give each test its own signup email.

```ts
it('403s a MEMBER attempting to create an app', async () => {
  // membership role 'MEMBER'
  expect(res.statusCode).toBe(403);
  expect(res.json()).toEqual({ error: 'insufficient role' });
});
it('lets an ADMIN create an app', async () => {
  // membership role 'ADMIN'
  expect(res.statusCode).toBe(201);
});
```

In `orgs/routes.test.ts` `describe('orgs')`:

```ts
it('never hands out a reserved slug', async () => {
  const u = await user('o@x.io');
  for (const [name, base] of [['Account', 'account'], ['New', 'new'], ['new!', 'new']] as const) {
    const res = await app.inject({ method: 'POST', url: '/v1/orgs', headers: as(u.token), payload: { name } });
    expect(res.statusCode).toBe(201);
    expect(res.json().slug).toMatch(new RegExp(`^${base}-[a-z0-9]{4}$`));
  }
});
```

In `orgs/invites.test.ts`, change the first test's assertion to:

```ts
expect(acc.json()).toEqual({ orgId: org.id, slug: org.slug, role: 'MEMBER' });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @query-analyser/api db:generate && pnpm --filter @query-analyser/api exec vitest run src/apps/routes.test.ts src/orgs/routes.test.ts src/orgs/invites.test.ts`
Expected: FAIL. The MEMBER create gets 201, `account` and `new` come back unsuffixed, and the accept body has no `slug`.

- [ ] **Step 3: Implement**

- `apps/routes.ts`: `requireRole('MEMBER')` → `requireRole('ADMIN')` on the create route only.
- `orgs/routes.ts`: add `const RESERVED_SLUGS = new Set(['account', 'new']);` (comment: they collide with static `/dashboard/*` routes). Then `const taken = RESERVED_SLUGS.has(base) || (await app.prisma.organization.findUnique({ where: { slug: base } }));`. The P2002 retry already suffixes.
- `orgs/invites.ts`: select `slug: true` in the accept route's `org` include, and return `{ orgId: inv.orgId, slug: inv.org.slug, role: inv.role }` from the transaction.

- [ ] **Step 4: Run the API suite to verify it passes**

Run: `pnpm --filter @query-analyser/api test && pnpm --filter @query-analyser/api exec tsc --noEmit`
Expected: all PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/apps apps/api/src/orgs
git commit -m "feat(api): admin-only app creation, reserved org slugs, slug on invite accept"
```

---

### Task 2: API — `PATCH /v1/me` and `POST /v1/me/password`

**Files:**
- Modify: `apps/api/src/auth/routes.ts` (next to `app.get('/v1/me'`)
- Create: `apps/api/src/auth/me.test.ts`

**Interfaces:**
- Consumes: `issue(reply, userId)` and `setRefresh`, both already inside `authRoutes`. `hashPassword` and `verifyPassword` from `./password.js`.
- Produces (Task 7's BFF calls these):
  - `PATCH /v1/me`. Auth: `app.authenticate` only. Body `{ name }`. Response `200 { id, email, name, isPlatformAdmin, emailVerifiedAt }` (the `GET /v1/me` select).
  - `POST /v1/me/password`. Auth: `app.authenticate` only. Rate limit `{ max: 10, timeWindow: '1 minute' }`. Body `{ currentPassword, newPassword }`. Responses:
    - `200 { accessToken, user: { id, email, name, isPlatformAdmin } }` plus `Set-Cookie: qa_refresh` (Path=/v1/auth);
    - `400 { error: 'invalid body' }`;
    - `400 { error: 'new password must differ from the current one' }`;
    - `403 { error: 'wrong-password' }`;
    - `401`.

- [ ] **Step 1: Write the failing tests** in `auth/me.test.ts`

Use the same harness as `orgs/routes.test.ts`: `buildApp({ logger: false })`, `resetDb` in `beforeEach`, and a `user(email)` helper that signs up with a distinct `remoteAddress` per call. The helper returns `{ id, token, cookie }`, where `cookie` is the signup response's `qa_refresh` value. Use `cookieOf` as in `auth.test.ts`. Every password request in the file gets its own `remoteAddress`, except the rate-limit test.

```ts
describe('PATCH /v1/me', () => {
  it('trims and saves the name and returns the GET /v1/me shape', async () => {
    // payload { name: '  Ada  ' } → 200
    expect(res.json()).toEqual({ id: u.id, email: 'a@x.io', name: 'Ada', isPlatformAdmin: false, emailVerifiedAt: expect.any(String) });
  });
  it('ignores unknown fields', async () => {
    // payload { name: 'Ada', email: 'evil@x.io', isPlatformAdmin: true } → 200
    // DB row still has email 'a@x.io' and isPlatformAdmin false
  });
  it('400s a blank or over-long name', async () => {
    // '   ' → 400; 'x'.repeat(101) → 400; {} → 400
  });
  it('401s without a token', async () => { /* 401 */ });
});

describe('POST /v1/me/password', () => {
  it('403s a wrong current password with wrong-password', async () => {
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'wrong-password' });
  });
  it('400s a new password under 12 chars and one equal to the current', async () => {
    // newPassword 'short-pass1' (11) → 400; newPassword === currentPassword → 400
  });
  it('changes the password, revokes every refresh token, and issues a working session', async () => {
    const u = await user('a@x.io');
    // a second device: log in again and keep its cookie as `other`
    const res = /* POST with { currentPassword: 'correct horse battery', newPassword: 'a-completely-new-password-1' } */;
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ accessToken: expect.any(String), user: { id: u.id, email: 'a@x.io' } });
    const fresh = cookieOf(res);
    expect(res.cookies.find((c) => c.name === 'qa_refresh')).toMatchObject({ httpOnly: true, path: '/v1/auth' });
    expect(await app.prisma.refreshToken.count({ where: { userId: u.id, consumedAt: null } })).toBe(1);
    // the old cookies are dead
    expect((await refresh(u.cookie)).statusCode).toBe(401);
    expect((await refresh(other)).statusCode).toBe(401);
    // replaying them did not take the new session down with them (Review Focus)
    expect((await refresh(fresh)).statusCode).toBe(200);
    // the new password logs in; the old one does not
  });
  it('rate-limits to 10 a minute', async () => {
    // 11 wrong-password attempts from one remoteAddress: the first 10 are 403, the 11th is 429
  });
  it('401s without a token', async () => { /* 401 */ });
});
```

`refresh(cookie)` is `app.inject({ method: 'POST', url: '/v1/auth/refresh', cookies: { qa_refresh: cookie } })`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @query-analyser/api exec vitest run src/auth/me.test.ts`
Expected: FAIL with 404s (the routes don't exist).

- [ ] **Step 3: Implement both routes in `auth/routes.ts`**

- Hoist the `GET /v1/me` select into `const meSelect = { id: true, email: true, name: true, isPlatformAdmin: true, emailVerifiedAt: true } as const;`. Use it in GET and PATCH.
- `nameSchema = z.object({ name: z.string().trim().min(1).max(100) })`. Zod strips unknown keys. On 400 the body is `{ error: 'invalid body' }`. Update by `req.user.id`.
- `changePasswordSchema = z.object({ currentPassword: z.string().min(1).max(200), newPassword: z.string().min(12).max(200) })`. Order of checks:
  1. parse → 400;
  2. `newPassword === currentPassword` → 400 with the "must differ" error (checked before argon2, so it costs nothing and leaks nothing);
  3. load the user (missing → 401 `{ error: 'unauthorized' }`);
  4. `verifyPassword` false → 403 `wrong-password`;
  5. update `passwordHash`;
  6. `refreshToken.updateMany({ where: { userId, consumedAt: null }, data: { consumedAt: new Date() } })` (the password-reset statement);
  7. then `const accessToken = await issue(reply, user.id)`. The order matters: the new token is issued after the revocation, so it survives.
  8. Reply with the login body shape.

- [ ] **Step 4: Run the API suite to verify it passes**

Run: `pnpm --filter @query-analyser/api test && pnpm --filter @query-analyser/api exec tsc --noEmit`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/auth/routes.ts apps/api/src/auth/me.test.ts
git commit -m "feat(api): edit your name and change your password"
```

---

### Task 3: API — leave an organisation

**Files:**
- Modify: `apps/api/src/orgs/routes.ts` (add after `app.delete('/v1/orgs/:org/members/:id'`)
- Test: `apps/api/src/orgs/routes.test.ts`

**Interfaces:**
- Consumes: `requireRole('VIEWER')`, plus `LastOwnerError` and `NOT_FOUND`, which are already declared inside `orgRoutes`.
- Produces: `DELETE /v1/orgs/:org/membership` (`:org` is the org id) → `204`, `404 { error: 'Not Found' }`, `403` (suspended org or unverified, via the existing preHandlers), or `409 { error: 'organization must keep at least one owner' }`. Task 7's BFF calls it.

- [ ] **Step 1: Write the failing tests** in a new `describe('leave')` in `orgs/routes.test.ts` (reuse `user()` and `as()`)

```ts
it('a MEMBER or VIEWER leaves: 204, membership gone, the org then 404s for them', async () => { /* both roles */ });
it('the only OWNER cannot leave', async () => {
  expect(res.statusCode).toBe(409);
  expect(res.json()).toEqual({ error: 'organization must keep at least one owner' });
  // membership still present
});
it('an OWNER can leave when another OWNER remains', async () => { /* 204; one OWNER left */ });
it('404s a non-member and a nonexistent org alike', async () => {
  // compare statusCode and json() of the two, as the members-list test does
});
it('two OWNERs leaving at once never leave the org ownerless', async () => {
  // Promise.all two DELETEs; sorted statuses toEqual([204, 409]); owner count 1
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @query-analyser/api exec vitest run src/orgs/routes.test.ts`
Expected: FAIL. The route 404s for everyone, so the 204 and 409 assertions fail.

- [ ] **Step 3: Implement `app.delete('/v1/orgs/:org/membership', { preHandler: [app.authenticate, app.requireVerified, requireRole('VIEWER')] }, …)`**

Mirror the member-removal transaction:
1. Re-read the caller's own row inside the transaction: `tx.membership.findUnique({ where: { userId_orgId: { userId: req.user.id, orgId } } })`. Missing → `NOT_FOUND`.
2. If it is OWNER, run the same `SELECT … FOR UPDATE` on the org's OWNER rows, count them, and throw `LastOwnerError` when the count is `<= 1`.
3. Delete the row.

Map the results as member removal does: 404, 204 and 409.

- [ ] **Step 4: Run the API suite to verify it passes**

Run: `pnpm --filter @query-analyser/api test && pnpm --filter @query-analyser/api exec tsc --noEmit`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/orgs/routes.ts apps/api/src/orgs/routes.test.ts
git commit -m "feat(api): leave an organisation, keeping at least one owner"
```

---

### Task 4: Web — landing, role-aware onboarding, `new=org`

**Files:**
- Modify: `apps/web/src/landing.ts`, `apps/web/src/landing.test.ts`
- Modify: `apps/web/src/dashboard-types.ts`
- Modify: `apps/web/src/onboarding-state.ts`, `apps/web/src/onboarding-state.test.ts`
- Modify: `apps/web/app/dashboard/page.tsx`, `apps/web/app/onboarding/page.tsx`
- Modify: `apps/web/components/onboarding/OnboardingFlow.tsx`
- Create: `apps/web/components/onboarding/OnboardingFlow.test.tsx`

**Interfaces:**
- Consumes: `Role` from `src/dashboard-types.ts`.
- Produces:
  - `src/landing.ts`:
    - `type Landing = { kind: 'onboarding' } | { kind: 'app'; org: string; app: string } | { kind: 'org'; org: string }`;
    - `resolveLanding(input)` (signature unchanged);
    - `orgPath(org: string): string`, which returns `/dashboard/${encodeURIComponent(org)}`;
    - `resolveOrgLanding(input: { org: string; apps: { id: string }[]; lastApp: string | undefined }): string | null`, which returns an `appPath` or `null` when the org has no apps;
    - `NEW_ORG_HREF = '/onboarding?new=org'` and `ACCOUNT_HREF = '/dashboard/account'`.
  - `src/dashboard-types.ts`: `ROLE_LABEL: Record<Role, string>` (`Owner`/`Admin`/`Member`/`Viewer`) and `isAdminRole(role: Role): boolean` (OWNER or ADMIN).
  - `src/onboarding-state.ts`: `resolveOnboardingStart(input: { emailVerified: boolean; orgs: { slug: string; role: Role }[]; targetOrg?: string; newOrg?: boolean; apps?: … })`. The return type is unchanged.

- [ ] **Step 1: Write the failing tests**

`landing.test.ts`: change `'org without apps goes to onboarding'` to expect `{ kind: 'org', org: 'acme' }`, then add:

```ts
it('with no apps anywhere, lands on the first org (its empty state), not onboarding', () =>
  expect(resolveLanding({ emailVerified: true, orgs: [{ slug: 'm1', apps: [] }, { slug: 'm2', apps: [] }], lastApp: undefined }))
    .toEqual({ kind: 'org', org: 'm1' }));
it('any app beats an empty org', () =>
  expect(resolveLanding({ emailVerified: true, orgs: [{ slug: 'empty', apps: [] }, ...orgs], lastApp: undefined }))
    .toEqual({ kind: 'app', org: 'acme', app: 'a1' }));
describe('orgPath', () => { it('encodes', () => expect(orgPath('ac me')).toBe('/dashboard/ac%20me')); });
describe('resolveOrgLanding', () => {
  it('last app in this org wins', () => expect(resolveOrgLanding({ org: 'acme', apps: [{ id: 'a1' }, { id: 'a2' }], lastApp: 'acme/a2' })).toBe('/dashboard/acme/a2/queries'));
  it('last app in another org is ignored', () => expect(resolveOrgLanding({ org: 'acme', apps: [{ id: 'a1' }], lastApp: 'beta/a1' })).toBe('/dashboard/acme/a1/queries'));
  it('a stale last app falls back to the first', () => expect(resolveOrgLanding({ org: 'acme', apps: [{ id: 'a1' }], lastApp: 'acme/zz' })).toBe('/dashboard/acme/a1/queries'));
  it('no apps → null', () => expect(resolveOrgLanding({ org: 'acme', apps: [], lastApp: undefined })).toBeNull());
});
```

`onboarding-state.test.ts`: add `role: 'OWNER'` to every existing `orgs` entry, so the current tests keep their meaning. Then add:

```ts
it('new=org starts at org even with orgs', () =>
  expect(resolveOnboardingStart({ emailVerified: true, orgs: [{ slug: 'a', role: 'OWNER' }], newOrg: true })).toEqual({ step: 'org' }));
it('new=org still verifies first', () =>
  expect(resolveOnboardingStart({ emailVerified: false, orgs: [], newOrg: true })).toEqual({ step: 'verify' }));
it.each(['MEMBER', 'VIEWER'] as const)('a %s in the first org is done, never app/install', (role) => {
  expect(resolveOnboardingStart({ emailVerified: true, orgs: [{ slug: 'a', role }] })).toBe('done');
  expect(resolveOnboardingStart({ emailVerified: true, orgs: [{ slug: 'a', role }], apps: [{ id: '2', name: 'two', lastSeenAt: null }] })).toBe('done');
});
it('a MEMBER targetOrg is done', () =>
  expect(resolveOnboardingStart({ emailVerified: true, orgs: [{ slug: 'a', role: 'OWNER' }, { slug: 'b', role: 'MEMBER' }], targetOrg: 'b' })).toBe('done'));
it('an ADMIN targetOrg starts at app', () =>
  expect(resolveOnboardingStart({ emailVerified: true, orgs: [{ slug: 'b', role: 'ADMIN' }], targetOrg: 'b' })).toEqual({ step: 'app', org: 'b' }));
```

`OnboardingFlow.test.tsx` (jsdom). `vi.mock('./OrgStep')` with a stub that renders a button labelled `create`, which calls `onCreated('acme-co')`. Also `vi.mock('./AppStep')` with a stub that renders `org` as text, and `vi.mock('@/app/_components/ContinueToInvite')` returning `usePendingInvite: () => null` and `ContinueToInviteLink: () => null`.

```ts
it('after the org is created, the URL names it, so a reload resumes at its app step', () => {
  window.history.replaceState(null, '', '/onboarding?new=org');
  render(<OnboardingFlow start={{ step: 'org' }} email="a@x.io" />);
  fireEvent.click(screen.getByRole('button', { name: 'create' }));
  expect(window.location.pathname + window.location.search).toBe('/onboarding?org=acme-co');
  expect(screen.getByText('acme-co')).toBeTruthy();
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @query-analyser/web exec vitest run src/landing.test.ts src/onboarding-state.test.ts components/onboarding/OnboardingFlow.test.tsx`
Expected: FAIL (missing exports, old behaviour).

- [ ] **Step 3: Implement**

- `landing.ts`: `resolveLanding` keeps rules 1 and 2. Before returning onboarding, it returns `{ kind: 'org', org: input.orgs[0].slug }` when `orgs` is non-empty. `resolveOrgLanding` reuses `readLastApp`'s `org/app` split and `appPath`. Export the two hrefs.
- `dashboard-types.ts`: `ROLE_LABEL` and `isAdminRole`.
- `onboarding-state.ts`, in order:
  1. not verified → verify;
  2. `orgs.length === 0 || newOrg` → `{ step: 'org' }`;
  3. a target that is found → `isAdminRole(target.role) ? { step: 'app', org } : 'done'`;
  4. `!isAdminRole(first.role)` → `'done'`;
  5. then the existing first-org logic.

  Update the doc comment.
- `app/dashboard/page.tsx`: redirect `'org'` to `orgPath(landing.org)`. Update the doc comment ("their last app, their first app, their first org, or onboarding").
- `app/onboarding/page.tsx`:
  - `searchParams: Promise<{ org?: string; new?: string }>`, with `const newOrg = sp.new === 'org'`;
  - the session/refresh `path` keeps `?new=org` (or `?org=…`);
  - pass `orgs` (they already carry `role`) and `newOrg` to `resolveOnboardingStart`;
  - skip the first-org apps lookup when `newOrg`, or when `!isAdminRole(orgs[0].role)`.
- `OnboardingFlow.tsx`: in `OrgStep`'s `onCreated`, call `window.history.replaceState(null, '', `/onboarding?org=${encodeURIComponent(slug)}`)` before `setOrg`/`setStep`.

- [ ] **Step 4: Run the web suite and typecheck**

Run: `pnpm --filter @query-analyser/web test && pnpm --filter @query-analyser/web exec tsc --noEmit`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/landing.ts apps/web/src/landing.test.ts apps/web/src/dashboard-types.ts apps/web/src/onboarding-state.ts apps/web/src/onboarding-state.test.ts apps/web/app/dashboard/page.tsx apps/web/app/onboarding/page.tsx apps/web/components/onboarding/OnboardingFlow.tsx apps/web/components/onboarding/OnboardingFlow.test.tsx
git commit -m "feat(web): land members on their org and start new organisations from onboarding"
```

---

### Task 5: Web — `/dashboard/[org]` org home, bare shell, invite accept goes to the team

**Files:**
- Create: `apps/web/components/dashboard/BareShell.tsx`
- Create: `apps/web/components/dashboard/OrgHome.tsx`, `apps/web/components/dashboard/OrgHome.test.tsx`
- Create: `apps/web/app/dashboard/[org]/page.tsx`
- Modify: `apps/web/app/api/invites/accept/route.ts`, `apps/web/src/invite-routes.test.ts`
- Modify: `apps/web/app/_components/AcceptInviteClient.tsx`, `apps/web/src/accept-invite-client.test.tsx`

**Interfaces:**
- Consumes: `orgPath`, `resolveOrgLanding`, `readLastApp`, `LAST_APP_COOKIE`, `NEW_ORG_HREF`, `ACCOUNT_HREF` (Task 4). `ROLE_LABEL` and `isAdminRole` (Task 4). Accept's `slug` (Task 1). `listOrgs` and `listApps` from `src/dashboard-api.ts`. `GlassCard`. `LogoutButton`.
- Produces:
  - `BareShell({ children, back }: { children: React.ReactNode; back?: { href: string; label: string } })`. Task 8 uses it.
  - `OrgHome({ org, orgs, suspended }: { org: { slug: string; name: string; role: Role }; orgs: { slug: string; name: string; role: Role }[]; suspended: boolean })`.
  - BFF accept → `200 { orgId: string; slug?: string }`.

- [ ] **Step 1: Write the failing tests**

`OrgHome.test.tsx` (jsdom). Mock `next/navigation` (`useRouter: () => ({ push: vi.fn(), refresh: vi.fn() })`) for `LogoutButton`.

```ts
it.each(['MEMBER', 'VIEWER'] as const)('a %s sees the ask-an-admin empty state and a way to their own org', (role) => {
  render(<OrgHome org={{ slug: 'team', name: 'Team', role }} orgs={[{ slug: 'team', name: 'Team', role }]} suspended={false} />);
  expect(screen.getByText('No apps yet. Ask an admin to connect one.')).toBeTruthy();
  expect(screen.getByRole('link', { name: 'Create your own organisation' }).getAttribute('href')).toBe('/onboarding?new=org');
  expect(screen.queryByRole('link', { name: 'Connect your first app' })).toBeNull();
});
it.each(['ADMIN', 'OWNER'] as const)('an %s is offered "Connect your first app" in this org', (role) => {
  // href '/onboarding?org=my%20org' for slug 'my org'
});
it('shows the org name and role, links every org to /dashboard/<slug>, and offers Account and Sign out', () => {
  // heading 'Team'; text 'Member'; link 'Other' → '/dashboard/other'; link 'Account' → '/dashboard/account'; button 'Sign out'
});
it('a suspended org says so and offers no setup (Review Focus)', () => {
  // suspended → text 'This organisation is suspended.'; no 'Connect your first app', no 'No apps yet…'
});
```

`invite-routes.test.ts` `describe('POST accept')`: the first test also asserts `expect(await res.json()).toEqual({ orgId: 'org1', slug: 'acme' })`, with the upstream mocked as `{ orgId: 'org1', slug: 'acme', role: 'MEMBER' }`.

`accept-invite-client.test.tsx`: the default mock reply becomes `{ orgId: 'org1', slug: 'acme', role: 'MEMBER' }`. Every `toHaveBeenCalledWith('/dashboard')` after a successful accept becomes `'/dashboard/acme'`. Add:

```ts
it('falls back to /dashboard when the response has no slug', async () => {
  fetchMock.mockResolvedValue(reply(200, { orgId: 'org1' }));
  render(<AcceptInviteClient />);
  await vi.waitFor(() => expect(router.replace).toHaveBeenCalledWith('/dashboard'));
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @query-analyser/web exec vitest run components/dashboard/OrgHome.test.tsx src/invite-routes.test.ts src/accept-invite-client.test.tsx`
Expected: FAIL (no OrgHome; no slug passed through; redirect still `/dashboard`).

- [ ] **Step 3: Implement**

- `BareShell`: a `<main>` (`mx-auto flex min-h-screen max-w-3xl flex-col gap-6 px-4 py-10`) with a header row. The row holds the wordmark link to `/`, in the same markup as `app/onboarding/page.tsx`, and, when `back` is given, a `text-sm text-muted-foreground` link with `back.label`. Children go below. No sidebar.
- `OrgHome`:
  - an `h1` with the org name, and a `Badge` with `ROLE_LABEL[role]`;
  - a `GlassCard strong` with the empty state: suspended → "This organisation is suspended."; otherwise branch on `isAdminRole`, using the Global Constraints copy and hrefs (`/onboarding?org=${encodeURIComponent(slug)}`, `NEW_ORG_HREF`). Style the links as pill buttons via `Button asChild`;
  - a `nav aria-label="Organisations"` listing each org as a link to `orgPath(slug)` with its role, the current one marked `aria-current="page"`, then an "Account" link (`ACCOUNT_HREF`) and `<LogoutButton />`.
- `app/dashboard/[org]/page.tsx` (server):
  1. `requireSession(orgPath(org))`; unverified → `redirect('/onboarding')`.
  2. `listOrgs`: 401 → refresh redirect with `next` = this path; other failure → throw.
  3. Find the org by slug; missing → `notFound()`.
  4. `listApps(t, org.id)`: 401 → refresh; 403 → render with `suspended`; 404 → `notFound()`; other failure → throw.
  5. `const target = resolveOrgLanding({ org: slug, apps, lastApp: readLastApp((await cookies()).get(LAST_APP_COOKIE)?.value) })`; if non-null, `redirect(target)`. Otherwise render `<BareShell><OrgHome … /></BareShell>`.
- Accept BFF: type the upstream as `{ orgId: string; slug?: string }` and return `{ orgId, slug }`.
- `AcceptInviteClient`: `router.replace(data.slug ? orgPath(data.slug) : '/dashboard')`. Parse the 200 body with `.json().catch(() => ({}))`.

- [ ] **Step 4: Run the web suite, typecheck and build**

Run: `pnpm --filter @query-analyser/web test && pnpm --filter @query-analyser/web exec tsc --noEmit && pnpm --filter @query-analyser/web build`
Expected: all PASS. The build lists `/dashboard/[org]`.

- [ ] **Step 5: Commit**

```bash
git add apps/web/components/dashboard/BareShell.tsx apps/web/components/dashboard/OrgHome.tsx apps/web/components/dashboard/OrgHome.test.tsx "apps/web/app/dashboard/[org]/page.tsx" apps/web/app/api/invites/accept/route.ts apps/web/src/invite-routes.test.ts apps/web/app/_components/AcceptInviteClient.tsx apps/web/src/accept-invite-client.test.tsx
git commit -m "feat(web): org home for orgs without apps; invitees land on their team"
```

---

### Task 6: Web — switcher lists organisations; role-gated New app; Account entry points

**Files:**
- Modify: `apps/web/components/dashboard/switcher.ts`, `apps/web/src/switcher.test.ts`
- Modify: `apps/web/components/dashboard/AppSwitcher.tsx`, `apps/web/components/dashboard/AppSwitcher.test.tsx`
- Modify: `apps/web/components/dashboard/Sidebar.tsx`, `apps/web/components/dashboard/Sidebar.test.tsx`
- Modify: `apps/web/app/dashboard/[org]/[app]/layout.tsx`

**Interfaces:**
- Consumes: `orgPath`, `NEW_ORG_HREF`, `ACCOUNT_HREF`, `ROLE_LABEL`, `isAdminRole` (Task 4). `/dashboard/[org]` (Task 5).
- Produces:
  - `orgsForSwitcher(orgs: { slug: string; name: string; role: Role }[], currentOrg: string): { slug: string; name: string; role: Role; href: string; current: boolean }[]`;
  - `AppSwitcher` props `{ groups; orgs: ReturnType<typeof orgsForSwitcher>; currentLabel; newAppHref: string | null }`, where `null` hides New app;
  - `SidebarAccount({ name, email }: { name: string; email: string })`.

- [ ] **Step 1: Write the failing tests**

`switcher.test.ts`:

```ts
it('lists orgs with role, href and the current one marked', () =>
  expect(orgsForSwitcher([{ slug: 'acme', name: 'Acme', role: 'OWNER' }, { slug: 'b c', name: 'B', role: 'MEMBER' }], 'b c')).toEqual([
    { slug: 'acme', name: 'Acme', role: 'OWNER', href: '/dashboard/acme', current: false },
    { slug: 'b c', name: 'B', role: 'MEMBER', href: '/dashboard/b%20c', current: true },
  ]));
```

`AppSwitcher.test.tsx`: `open()` takes `newAppHref: string | null = '/onboarding?org=o'` and passes `orgs={[{ slug: 'o', name: 'Org', role: 'OWNER', href: '/dashboard/o', current: true }, { slug: 't', name: 'Team', role: 'MEMBER', href: '/dashboard/t', current: false }]}`. The three existing tests keep passing. Add:

```ts
it('lists organisations with the role and marks the current one', () => {
  open();
  const team = screen.getByText('Team').closest('a')!;
  expect(team.getAttribute('href')).toBe('/dashboard/t');
  expect(team.textContent).toContain('Member');
  const marks = screen.getAllByLabelText('current organisation');
  expect(marks).toHaveLength(1);
  expect(marks[0]!.closest('a')?.getAttribute('href')).toBe('/dashboard/o');
});
it('offers New organisation and Account to everyone', () => {
  open(null);
  expect(screen.getByText('New organisation').closest('a')?.getAttribute('href')).toBe('/onboarding?new=org');
  expect(screen.getByText('Account').closest('a')?.getAttribute('href')).toBe('/dashboard/account');
});
it('hides New app when the role cannot create apps', () => {
  open(null);
  expect(screen.queryByText('New app')).toBeNull();
});
it('shows New app for admins', () => {
  open();
  expect(screen.getByText('New app').closest('a')?.getAttribute('href')).toBe('/onboarding?org=o');
});
```

`Sidebar.test.tsx`:

```ts
describe('SidebarAccount', () => {
  it('links the name and email to the account page', () => {
    render(<SidebarAccount name="Ada" email="ada@x.io" />);
    const link = screen.getByRole('link', { name: /Ada/ });
    expect(link.getAttribute('href')).toBe('/dashboard/account');
    expect(link.textContent).toContain('ada@x.io');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @query-analyser/web exec vitest run src/switcher.test.ts components/dashboard/AppSwitcher.test.tsx components/dashboard/Sidebar.test.tsx`
Expected: FAIL (missing exports and items).

- [ ] **Step 3: Implement**

- `orgsForSwitcher` goes in `switcher.ts`.
- `AppSwitcher`:
  - a first `CommandGroup heading="Organisations"`, with one `CommandItem` per org (`value={`org:${o.slug}`}`) that wraps a `Link` to `o.href`. The link shows the name, `ROLE_LABEL[o.role]` in `text-xs text-muted-foreground`, and, when current, `<Check aria-label="current organisation" />`;
  - then the existing app groups;
  - then a separator and a final group: New app (only when `newAppHref`, `value="new-app"`), New organisation (`value="new-org"`, icon `Building2`), Account (`value="account"`, icon `UserRound`).

  All are anchors with the existing `go`/`close` handling.
- `SidebarAccount`: a `Link` to `ACCOUNT_HREF`, with the name (`truncate font-medium`) above the email (`truncate text-muted-foreground`), and a hover background.
- `layout.tsx`:
  - pass `orgs={orgsForSwitcher(orgs, org)}`;
  - set `newAppHref` to `isAdminRole(currentOrg.role) ? `/onboarding?org=${encodeURIComponent(org)}` : null`;
  - the footer becomes `<SidebarAccount name={session.user.name} email={session.user.email} />` above `<LogoutButton />`.

- [ ] **Step 4: Run the web suite and typecheck**

Run: `pnpm --filter @query-analyser/web test && pnpm --filter @query-analyser/web exec tsc --noEmit`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/components/dashboard/switcher.ts apps/web/src/switcher.test.ts apps/web/components/dashboard/AppSwitcher.tsx apps/web/components/dashboard/AppSwitcher.test.tsx apps/web/components/dashboard/Sidebar.tsx apps/web/components/dashboard/Sidebar.test.tsx "apps/web/app/dashboard/[org]/[app]/layout.tsx"
git commit -m "feat(web): switch and create organisations from the app switcher"
```

---

### Task 7: Web — BFF routes for name, password and leaving an org

**Files:**
- Create: `apps/web/app/api/me/route.ts` (PATCH)
- Create: `apps/web/app/api/me/password/route.ts` (POST)
- Create: `apps/web/app/api/orgs/[org]/membership/route.ts` (DELETE)
- Create: `apps/web/src/account-routes.test.ts`

**Interfaces:**
- Consumes:
  - `gate`, `isSafeSegment`, `badParam`, `jsonError`, `NO_STORE` from `src/org-bff.ts`;
  - `authedFetch` and `apiOrigin` from `src/api.ts`;
  - `upstreamAuthHeaders` from `src/upstream-headers.ts`;
  - `SESSION_COOKIE` and `sessionCookieOptions` from `src/session.ts`;
  - `forwardRefreshCookie` from `src/refresh-cookie.ts`;
  - `LAST_APP_COOKIE` from `src/landing.ts`;
  - `safeUpstreamMessage`;
  - the API routes from Tasks 2 and 3.
- Produces (Task 8's components call these):
  - `PATCH /api/me`, body `{ name }` → `200 { name: string }`, or `{ error }` with 400/401/403/429/502.
  - `POST /api/me/password`, body `{ currentPassword, newPassword }` → `200 { ok: true }` plus `Set-Cookie` for `qa_session` and `qa_refresh` (Path=/api/auth); or `{ error }` with 400/401/403/429/502.
  - `DELETE /api/orgs/[org]/membership` → 204 plus `Set-Cookie: qa_last_app=; Path=/dashboard; Max-Age=0`; or `{ error }` with 400/401/403/404/409/429/502.

Error copy (pinned):
- PATCH 400: `'Enter a name between 1 and 100 characters.'`
- Password 400: `'Choose a new password of 12–200 characters that differs from your current one.'`
- Password 403: `'Your current password is incorrect.'`
- Leave 404: `"You're no longer a member of this organisation."`
- Leave 409: `"You're the only owner. Make someone else an owner first."`
- 401 → `'unauthorized'`. 429 and anything else → `safeUpstreamMessage(status, 'generic')`, with 403 passed through and everything else as 502.

- [ ] **Step 1: Write the failing tests** in `src/account-routes.test.ts`

Use the `invite-routes.test.ts` harness: mock `@/src/auth` `getSession`, and mock `@/src/api` with `apiOrigin: () => 'https://api.test'` plus `authedFetch: vi.fn()`, and reuse its `req()`. For the password route, also stub `globalThis.fetch` per test, as `credentials-auth.test.ts` does, and restore it in `afterEach`.

```ts
describe('cross-site, session and params', () => {
  it('every route 403s a cross-site request with no-store, upstream untouched', async () => { /* PATCH, POST password, DELETE membership with origin evil */ });
  it('every route 401s without a session', async () => { /* … */ });
  it('membership rejects unsafe org segments with 400', async () => {
    for (const bad of ['.', '..', 'a/b', 'a.b', '']) expect((await leave(req('DELETE'), orgCtx(bad))).status).toBe(400);
  });
});
describe('PATCH /api/me', () => {
  it('forwards only a trimmed name', async () => {
    // body { name: ' Ada ', email: 'x@y.z', isPlatformAdmin: true } → authedFetch('/v1/me', 'tok', { method: 'PATCH', body: '{"name":"Ada"}' })
    // response 200 { name: 'Ada' }, no-store
  });
  it('400s a blank, over-long or non-string name without calling upstream', async () => { /* '  ', 'x'.repeat(101), 5 */ });
});
describe('POST /api/me/password', () => {
  it('forwards only the two fields, with the bearer token and the browser IP, and sets both session cookies (Review Focus)', async () => {
    // fetch stub returns 200 { accessToken: 'new-tok', user: {...} } with set-cookie 'qa_refresh=r2; Path=/v1/auth; HttpOnly; SameSite=Lax'
    // request carries x-forwarded-for: '203.0.113.9'
    const [url, init] = fetchStub.mock.calls[0];
    expect(url).toBe('https://api.test/v1/me/password');
    expect(JSON.parse(init.body)).toEqual({ currentPassword: 'old-password-1', newPassword: 'new-password-12' });
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer tok');
    expect(new Headers(init.headers).get('x-qa-client-ip')).toBe('203.0.113.9');
    const cookies = res.headers.getSetCookie();
    expect(cookies.some((c) => c.startsWith('qa_session=new-tok'))).toBe(true);
    expect(cookies.find((c) => c.startsWith('qa_refresh='))).toContain('Path=/api/auth');
    const body = await res.json();
    expect(body).toEqual({ ok: true });
    expect(JSON.stringify(body)).not.toContain('new-tok');
  });
  it('maps 403 wrong-password to its copy and sets no cookies', async () => { /* … */ });
  it('400s a new password under 12 or over 200 chars without calling upstream', async () => { /* … */ });
  it('maps an upstream 429 and a network failure', async () => { /* 429 → 429 safe message; fetch throws → 502 */ });
});
describe('DELETE /api/orgs/[org]/membership', () => {
  it('204 clears the last-app cookie', async () => {
    // authedFetch → { ok: true, data: undefined }; call()[0] === '/v1/orgs/org1/membership', method DELETE
    const c = res.headers.getSetCookie().find((x) => x.startsWith('qa_last_app='))!;
    expect(c).toMatch(/Path=\/dashboard/);
    expect(c).toMatch(/Max-Age=0/);
  });
  it('409 → the only-owner copy, cookie untouched', async () => { /* exact copy; no qa_last_app set-cookie */ });
  it('404 → no-longer-a-member copy', async () => { /* … */ });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @query-analyser/web exec vitest run src/account-routes.test.ts`
Expected: FAIL (modules not found).

- [ ] **Step 3: Implement the three handlers**

- `app/api/me/route.ts` `PATCH(request)`: `gate(request, true)`, then read `name` as a string, trim it, and check 1–100. Call `authedFetch<{ name: string }>('/v1/me', token, { method: 'PATCH', body: JSON.stringify({ name }) })` and return `{ name: res.data.name }`.
- `app/api/me/password/route.ts` `POST(request)`:
  - `gate(request, true)`, then check that both fields are strings, `currentPassword` is 1–200 and `newPassword` is 12–200;
  - a raw `fetch(`${apiOrigin()}/v1/me/password`, { method: 'POST', headers: upstreamAuthHeaders(request, { 'content-type': 'application/json', authorization: `Bearer ${token}` }), body, cache: 'no-store' })`, wrapped in try/catch (a throw → 502). `authedFetch` can't be used: it drops `Set-Cookie` and doesn't forward the client IP;
  - on 2xx, mirror `handleCredentialsAuth`: `res.cookies.set(SESSION_COOKIE, accessToken, sessionCookieOptions(process.env.NODE_ENV === 'production'))`, then `forwardRefreshCookie(upstream, res)`, with the body `{ ok: true }` and no-store;
  - map errors with the copy above.
- `app/api/orgs/[org]/membership/route.ts` `DELETE(request, { params })`:
  - `gate`, then `isSafeSegment(org)` or `badParam()`, then `authedFetch(`/v1/orgs/${org}/membership`, token, { method: 'DELETE' })`;
  - on success, a 204 with no-store and `res.cookies.set(LAST_APP_COOKIE, '', { path: '/dashboard', maxAge: 0 })`;
  - comment: the cookie is scoped to `/dashboard` and holds a slug, so this handler can neither read it nor match it against the org id. It is cleared unconditionally, and `resolveLanding` already ignores a stale value.

- [ ] **Step 4: Run the web suite and typecheck**

Run: `pnpm --filter @query-analyser/web test && pnpm --filter @query-analyser/web exec tsc --noEmit`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/app/api/me "apps/web/app/api/orgs/[org]/membership" apps/web/src/account-routes.test.ts
git commit -m "feat(web): BFF routes for profile, password change and leaving an org"
```

---

### Task 8: Web — the Account page

**Files:**
- Create: `apps/web/app/dashboard/account/page.tsx`
- Create: `apps/web/components/account/ProfileCard.tsx`, `ProfileCard.test.tsx`
- Create: `apps/web/components/account/PasswordCard.tsx`, `PasswordCard.test.tsx`
- Create: `apps/web/components/account/OrganisationsCard.tsx`, `OrganisationsCard.test.tsx`
- Modify: `apps/web/src/dashboard-style.test.tsx` (add `'components/account'` to the periwinkle-text scan list)

**Interfaces:**
- Consumes: `BareShell` (Task 5). `orgPath`, `NEW_ORG_HREF` (Task 4). `ROLE_LABEL` (Task 4). The three BFF routes and their error copy (Task 7). `requireSession` and `listOrgs`.
- Produces:
  - `ProfileCard({ name, email, verified }: { name: string; email: string; verified: boolean })`;
  - `PasswordCard()`;
  - `OrganisationsCard({ orgs }: { orgs: { id: string; slug: string; name: string; role: Role }[] })`.

- [ ] **Step 1: Write the failing tests** (jsdom, `afterEach(cleanup)`, `fetch` stubbed with the `reply()` helper from `Members.test.tsx`, and `next/navigation` mocked with `useRouter: () => router`, where `router = { refresh: vi.fn(), push: vi.fn() }`)

`ProfileCard.test.tsx`:

```ts
it('saves a trimmed name via PATCH /api/me and announces it', async () => {
  // change 'Name' to '  Grace ' → click 'Save' → fetch('/api/me', { method: 'PATCH', body '{"name":"Grace"}', content-type json })
  expect((await screen.findByRole('status')).textContent).toMatch(/Saved/);
  expect(router.refresh).toHaveBeenCalled();
});
it('shows the email read-only with its verified badge', () => {
  // the email text is present; no textbox has the email as its value; text 'Verified'
});
it('shows the BFF error in an alert', async () => { /* 400 { error } → alert text */ });
```

`PasswordCard.test.tsx`:

```ts
it('says other devices sign out within 15 minutes', () => {
  expect(screen.getByText('Other devices are signed out within 15 minutes.')).toBeTruthy();
});
it.each([
  ['short', 'short', 'Use at least 12 characters.'],
  ['new-password-12', 'new-password-13', "The new passwords don't match."],
])('validates locally before sending (%s)', async (next, confirm, message) => {
  // current 'old-password-1'; alert has message; fetch not called
});
it('refuses a new password equal to the current one', async () => { /* 'Choose a password different from your current one.' */ });
it('posts the change and clears the fields on success', async () => {
  // fetch('/api/me/password', POST, body { currentPassword, newPassword }) → 200
  // status 'Password changed.'; all three inputs empty
});
it('shows a wrong current password from the BFF', async () => { /* 403 { error: 'Your current password is incorrect.' } → alert */ });
```

`OrganisationsCard.test.tsx`:

```ts
const orgs = [{ id: 'o1', slug: 'acme', name: 'Acme', role: 'OWNER' }, { id: 'o2', slug: 'team', name: 'Team', role: 'MEMBER' }];
it('lists each org with role and an Open link to its dashboard', () => {
  // 'Owner' and 'Member' shown; link 'Open Team' → '/dashboard/team'
  // link 'Create organisation' → '/onboarding?new=org'
});
it('leaves only after confirming, removes the row, announces it and keeps focus off <body>', async () => {
  // click 'Leave Team' → fetch not called yet → click 'Leave organisation'
  // fetch('/api/orgs/o2/membership', DELETE, content-type json) → 204
  // 'Team' row gone; status 'You left Team.'; document.activeElement text matches /Your organisations/
  // router.refresh called; router.push not called (stays on Account)
});
it('shows the only-owner message on 409 and keeps the row', async () => {
  // 409 { error: "You're the only owner. Make someone else an owner first." } → alert with exactly that; 'Acme' still listed
});
it('says so when the last org is gone', async () => { /* leave the only org → "You're not in any organisation yet." */ });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @query-analyser/web exec vitest run components/account`
Expected: FAIL (modules not found).

- [ ] **Step 3: Implement the three cards**

Follow `components/settings/Members.tsx` throughout:
- `Card` with an `h2` heading, `Input` with `<label htmlFor>`;
- `role="status"` for success and `role="alert"` for errors;
- `refreshSession()` on 401, and `AlertDialog` for the confirm;
- the `focusTo` + heading `ref` / `tabIndex={-1}` pattern after a row unmounts;
- the busy state disables the row's buttons, so a double click can't send twice.

Card details:
- `ProfileCard`: Name input (`maxLength={100}`) with a Save button. The email is plain text, with a `Badge` "Verified" when `verified`, else "Not verified". On 200, show "Saved." and call `router.refresh()`.
- `PasswordCard`: "Current password", "New password" and "Confirm new password" (`type="password"`, `autoComplete` `current-password` / `new-password`). It validates in this order: length ≥ 12, then match, then different from current. The description text is the 15-minute copy. On 200, show "Password changed." and clear all three inputs.
- `OrganisationsCard`:
  - the heading is "Your organisations";
  - each row shows the name and `ROLE_LABEL[role]`, an "Open" link (`aria-label={`Open ${name}`}`, `href={orgPath(slug)}`) and a "Leave" button (`aria-label={`Leave ${name}`}`);
  - the dialog title is `Leave ${name}?`, with the description "You lose access to its apps right away. Someone will need to invite you again." and the action "Leave organisation";
  - on 204, remove the row, show `You left ${name}.`, focus the heading and call `router.refresh()`;
  - the "Create organisation" link is `NEW_ORG_HREF`.

- [ ] **Step 4: Implement `app/dashboard/account/page.tsx`**

- Server component.
- `requireSession('/dashboard/account')`. Unverified → `redirect('/onboarding')`, as every `/dashboard` route does.
- `listOrgs`: 401 → `/api/auth/refresh?next=%2Fdashboard%2Faccount`; other failure → throw.
- Render `<BareShell back={{ href: '/dashboard', label: '← Back to dashboard' }}>` with an `h1` "Account", then `ProfileCard` (`verified={Boolean(session.user.emailVerifiedAt)}`), `PasswordCard` and `OrganisationsCard` (with `id, slug, name, role` from the orgs).
- Add `'components/account'` to the scan array in `src/dashboard-style.test.tsx`.

- [ ] **Step 5: Run everything**

Run:
```bash
pnpm --filter @query-analyser/api db:generate && pnpm --filter @query-analyser/api test && pnpm --filter @query-analyser/api exec tsc --noEmit
pnpm --filter @query-analyser/web test && pnpm --filter @query-analyser/web exec tsc --noEmit && pnpm --filter @query-analyser/web build
```
Expected: all PASS. The build lists `/dashboard/account` as its own route, separate from `/dashboard/[org]`.

- [ ] **Step 6: Commit**

```bash
git add apps/web/app/dashboard/account apps/web/components/account apps/web/src/dashboard-style.test.tsx
git commit -m "feat(web): account page for name, password and organisations"
```
