# Plans, Per-App Access and App Deletion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make plan limits data (orgs, apps, seats, invitable roles, retention), scope MEMBER/VIEWER teammates to the apps they were invited to, and let admins delete an app.

**Architecture:**
- The API gains `src/plans.ts` (the limit table) and `src/orgs/locks.ts` (row locks, including the moved `lockOwnersAndTarget`). Every limit is checked inside the transaction that creates the row, after locking the org row (or the user row for orgs).
- A new `AppAccess` table, plus `Invite.appId`, scopes MEMBER/VIEWER to apps. `requireAppRole` and the app list read it; invites, accept, role changes and member removal keep it in step. One migration adds both and backfills existing members idempotently.
- The web learns limits from a new `limits` field on `GET /v1/orgs` rows and seat usage from `GET /v1/apps/:id/access`. It disables create buttons and long ranges, hides Settings from non-admins, and moves inviting to a per-app "People with access" section with a Danger zone beside it.

**Tech Stack:** TypeScript, Fastify 5 + Prisma 7 (Postgres 17), zod, Next 16 App Router, React 19, cmdk, radix AlertDialog, Vitest + Testing Library.

**Spec:** `docs/superpowers/specs/2026-10-20-plans-and-app-access-design.md`. Read it; it is the authority. Its "controller's call" and "user's rule" items are decided. Where this plan resolves a conflict between the spec and the code, the resolution is listed under "Decisions" below.

## Global Constraints

- Plan table (`Organization.plan`; unknown string → `free`):

  | plan | ownedOrgs | apps | seats | invitableRoles | dailyRetentionDays |
  |---|---|---|---|---|---|
  | `free` | 1 | 1 | 1 | `MEMBER` | 7 |
  | `pro` | 1 | 3 | 5 | `ADMIN`, `MEMBER`, `VIEWER` | 30 |
  | `team` | 3 | 10 | 20 | `ADMIN`, `MEMBER`, `VIEWER` | 90 |
- Limit refusal: **`403 { error: 'plan-limit', limit: 'orgs' | 'apps' | 'seats' | 'role', max: number }`**. For `role`, `max` is the number of the plan's invitable roles.
- Web copy for refusals, verbatim:
  - orgs: "During the beta, each account can create one organisation. More with paid plans."
  - apps: "During the beta, each organisation has one app. Delete it to connect a different one, or upgrade later."
  - seats: "During the beta, you can invite one teammate. More seats with paid plans."
  - role: "During the beta, teammates join as Members."
- Other pinned copy: "Kept for N days on your plan", "N of M seats used", "People with access", "Remove access", "Danger zone", "Delete app", per-app roles shown as "Member · Shop, Admin panel".
- Hourly retention stays 7 days. Nothing is deleted or demoted because an org is already over a limit; it just can't add more. Retention is the one exception.
- Every limit holds under concurrent requests: org-row lock (`lockOrg`) for apps, seats and role changes; user-row lock (`lockUser`) for orgs. Lock order is always `Organization` row, then `Membership` rows.
- Non-members, and members without an `AppAccess` row, get **404, never 403**, for an app, with the body `{ error: 'Not Found' }`.
- Migration: additive only, created with `pnpm --filter @query-analyser/api exec prisma migrate dev --create-only --name plans_and_app_access`, committed. The backfill is idempotent and safe on an empty DB.
- No new dependencies.
- BFF handlers: `gate(request, mutation)` from `src/org-bff.ts`, then path params through `isSafeSegment`, bodies forwarded as explicit allowlists, fixed messages, `cache-control: no-store` on every response.
- Settings (app settings page, org Members, People) are ADMIN+ only. Account stays open to everyone. `GET /v1/apps/:id/sample-key` stays VIEWER+.
- Component tests: first line `// @vitest-environment jsdom`, `afterEach(cleanup)`. Accessibility as in `components/settings/Members.tsx`: labels on inputs, `role="status"` / `role="alert"`, focus to the list heading after a row unmounts.
- Commits: conventional (`feat(api): …`, `feat(web): …`), **no co-author trailers**. Never push. Do not copy the repo or create worktrees (disk is ~2 GiB free).
- API tests need `pnpm --filter @query-analyser/api db:generate` first and Postgres via `DATABASE_URL`. Run full suites under `caffeinate -i`. Every existing test stays green; where a fixture breaks only because of the new free limits, set that org's `plan` to `'team'` in the fixture. Never weaken an assertion.

## Review Focus

- **Ingest after deleting an app:** the SDK keeps sending with the deleted app's key, which `KeyResolver` caches for 60 s. Ingest must 401 at once, not 500 on a foreign key. Pinned in Task 7.
- **An app-less member probing an app in a suspended org:** they must get the same 404 as a nonexistent app, not 403 "organization suspended". Pinned in Task 3.
- **Inviting at the seat cap someone who adds no person:** re-inviting a pending email, or inviting an existing member to another app, must not be refused for seats. A new email must be. Pinned in Task 4.
- **Accepting an invite whose access you already have:** 409, and the invite is still consumed, so it leaves the pending lists and stops being counted. Throwing inside the transaction would roll the claim back and leave a dead invite pending forever. Pinned in Task 5.
- **A bookmarked `?range=30d` on a 7-day plan:** falls back to the default 24h range instead of rendering a silently partial chart. Pinned in Task 10.

## Decisions (spec meets code)

1. **Seats** are distinct people: `|member emails ∪ pending unexpired invite emails| − 1`. An invite to an email already in that set never needs a seat.
2. The old 50-pending-invite cap (`MAX_PENDING_INVITES`, 409) is removed. Every plan's seat cap (≤ 20, under a lock) is stricter. Its test becomes a seat test, and the BFF's 409 copy goes.
3. The old "only an owner can invite an owner" 403 is removed. OWNER invites are refused on every plan as `plan-limit` / `role`.
4. `PATCH`/`DELETE /v1/orgs/:org/members/:id` stay OWNER-only (stricter than the spec's "ADMIN+"). Only the members list is ADMIN+.
5. `lockOwnersAndTarget` moves out of the `orgRoutes` closure into `src/orgs/locks.ts`, so accept can use it.
6. Accept: the pre-transaction "already a member" 409 goes. The 409 is decided inside the transaction and returned as a sentinel, never thrown, so the claim commits.
7. App invite to someone with a row for that app: same role → 409; different role → row set to the invite's role, 200.
8. A legacy OWNER invite accepted by an existing member → 409, as before. An ADMIN invite accepted by a MEMBER/VIEWER → promoted to ADMIN, rows deleted.
9. **Retention shrinks** for free orgs from 90 to 7 days of daily data on the first nightly prune after deploy. The spec says so; call it out in the PR description.
10. An `appId` from another org gets 404 (the same as a nonexistent one), not 400.
11. `requireAppRole` checks access before suspension, so suspension can't reveal app existence.
12. `PATCH` to the member's current role is a no-op that's always allowed, so a grandfathered VIEWER on free isn't refused.
13. App deletion invalidates the app's cached ingest keys.

---

## File Structure

**API (`apps/api`)**
- `src/plans.ts` (new): `PLAN_LIMITS`, `limitsFor`, `PlanLimitError`, `sendPlanLimit`. Test `src/plans.test.ts`.
- `src/orgs/locks.ts` (new): `lockOrg`, `lockUser`, `lockOwnersAndTarget` (moved).
- `src/orgs/seats.ts` (new): `seatState`.
- `prisma/schema.prisma`, `prisma/migrations/<ts>_plans_and_app_access/migration.sql` (new). Test `src/orgs/app-access-migration.test.ts`.
- `src/orgs/rbac.ts`: `requireAppRole` reads `AppAccess`.
- `src/orgs/routes.ts`: org-create limit, `limits` on the list, role-change rules, removal deletes rows, members list gains apps.
- `src/orgs/invites.ts`: create (appId, role, seats), list (`appId`), accept (new rules).
- `src/mail/templates.ts`: `inviteEmail` names the app.
- `src/apps/routes.ts`: app-create limit, filtered list, `DELETE /v1/apps/:id`. `src/apps/access.ts` (new): `GET /v1/apps/:id/access`, `DELETE /v1/apps/:id/access/:userId`. Test `src/apps/access.test.ts`.
- `src/analysis/compaction.ts`, `src/analysis/jobs.ts`: per-plan daily pruning.

**Web (`apps/web`)**
- `src/api.ts` (`limit` on failures), `src/dashboard-types.ts`, `src/plan-limits.ts` (new), `src/org-bff.ts`, `src/dashboard-api.ts`.
- BFF: `app/api/onboarding/{org,app}/route.ts`, `app/api/orgs/[org]/invites/route.ts`, `app/api/orgs/[org]/members/[id]/route.ts`, `app/api/invites/accept/route.ts`. New: `app/api/apps/[id]/route.ts`, `app/api/apps/[id]/access/route.ts`, `app/api/apps/[id]/access/[userId]/route.ts`.
- Shell: `components/dashboard/{Sidebar,AppSwitcher,OrgHome,RangeControl}.tsx`, `components/account/OrganisationsCard.tsx`, `src/range.ts`, `src/filters.ts`, the `[org]/[app]` layout, queries pages, org page and account page.
- Settings: `app/dashboard/[org]/[app]/settings/page.tsx`, `components/settings/Members.tsx`, plus new `components/settings/People.tsx` and `components/settings/DeleteApp.tsx`.

---

### Task 1: API — plan limits module, row locks, org and app creation limits

**Files:**
- Create: `apps/api/src/plans.ts`, `apps/api/src/plans.test.ts`, `apps/api/src/orgs/locks.ts`
- Modify: `apps/api/src/orgs/routes.ts` (`GET /v1/orgs`, `POST /v1/orgs`; `lockOwnersAndTarget` moves out)
- Modify: `apps/api/src/apps/routes.ts` (`POST /v1/orgs/:org/apps`)
- Test: `apps/api/src/orgs/routes.test.ts`, `apps/api/src/apps/routes.test.ts`, plus any other test whose fixture now exceeds a free limit

**Interfaces:**
- Consumes: `Role` from `../db.js`; `Prisma` from `../generated/prisma/client.js`.
- Produces:
  - `plans.ts`:
    - `type LimitKind = 'orgs' | 'apps' | 'seats' | 'role'`;
    - `interface PlanLimits { ownedOrgs: number; apps: number; seats: number; invitableRoles: readonly Role[]; dailyRetentionDays: number }`;
    - `PLAN_LIMITS: Readonly<Record<'free' | 'pro' | 'team', PlanLimits>>` (the Global Constraints table);
    - `limitsFor(plan: string): PlanLimits`;
    - `class PlanLimitError extends Error { constructor(readonly limit: LimitKind, readonly max: number) }`;
    - `sendPlanLimit(reply: FastifyReply, e: PlanLimitError)`, which sends `403 { error: 'plan-limit', limit, max }`.
  - `orgs/locks.ts`:
    - `lockOrg(tx: Prisma.TransactionClient, orgId: string): Promise<{ plan: string } | null>`;
    - `lockUser(tx: Prisma.TransactionClient, userId: string): Promise<void>`;
    - `lockOwnersAndTarget(tx, orgId, target: { id: string } | { userId: string }): Promise<{ row?: { id: string; userId: string; role: string }; ownerCount: number }>` (moved verbatim with its doc comment).
  - `GET /v1/orgs` rows gain `limits: PlanLimits`.
  - `POST /v1/orgs` and `POST /v1/orgs/:org/apps` may answer `403 plan-limit` (`orgs` / `apps`).

- [ ] **Step 1: Write the failing tests**

`plans.test.ts`:

```ts
it('has the beta table', () => {
  expect(limitsFor('free')).toEqual({ ownedOrgs: 1, apps: 1, seats: 1, invitableRoles: ['MEMBER'], dailyRetentionDays: 7 });
  expect(limitsFor('pro')).toEqual({ ownedOrgs: 1, apps: 3, seats: 5, invitableRoles: ['ADMIN', 'MEMBER', 'VIEWER'], dailyRetentionDays: 30 });
  expect(limitsFor('team')).toEqual({ ownedOrgs: 3, apps: 10, seats: 20, invitableRoles: ['ADMIN', 'MEMBER', 'VIEWER'], dailyRetentionDays: 90 });
});
it.each(['', 'enterprise', 'FREE', 'constructor', '__proto__', 'toString'])('unknown plan %j gets free limits', (p) =>
  expect(limitsFor(p)).toBe(PLAN_LIMITS.free));
```

`orgs/routes.test.ts`, new `describe('org limit')` (reuse `user()`, `as()`):

```ts
it('a free owner cannot create a second org', async () => {
  // first POST /v1/orgs → 201; second → 403
  expect(res.json()).toEqual({ error: 'plan-limit', limit: 'orgs', max: 1 });
});
it('being invited into other orgs does not count', async () => {
  // u is MEMBER (prisma.membership.create) of someone else's org → u's POST /v1/orgs → 201
});
it('the largest limit among owned orgs applies', async () => {
  // u owns one org; set its plan 'team' → u can create 2 more (201, 201); the 4th → 403 max 3
});
it('two concurrent creates by a free user make exactly one org', async () => {
  // Promise.all two POST /v1/orgs → statuses sorted [201, 403]; owner memberships count 1
});
it('lists each org with its plan limits', async () => {
  // GET /v1/orgs → [ { ..., plan: 'free', limits: limitsFor('free') } ]
});
```

`apps/routes.test.ts`, inside `describe('apps')`:

```ts
it('a free org cannot create a second app', async () => {
  // web/production → 201; api/production → 403
  expect(res.json()).toEqual({ error: 'plan-limit', limit: 'apps', max: 1 });
});
it('two concurrent creates of different apps on free make exactly one app', async () => {
  // Promise.all names 'a' and 'b' → sorted [201, 403]; app count 1
});
it('an org already over its limit keeps its apps but cannot add one', async () => {
  // insert 2 apps via prisma.app.create → POST a third → 403 apps; count still 2
});
it('a team org can create up to 10', async () => { /* set plan 'team'; 10 × 201; 11th 403 max 10 */ });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @query-analyser/api db:generate && pnpm --filter @query-analyser/api exec vitest run src/plans.test.ts src/orgs/routes.test.ts src/apps/routes.test.ts`
Expected: FAIL. `plans.ts` is missing, the second org and second app get 201, and `limits` is absent.

- [ ] **Step 3: Implement `plans.ts` and `orgs/locks.ts`**

- `limitsFor` uses `Object.hasOwn(PLAN_LIMITS, plan)` so prototype keys fall back to free. Freeze the table and its role arrays.
- `lockOrg` is `SELECT plan FROM "Organization" WHERE id = ${orgId} FOR UPDATE` and returns `null` when there is no row. `lockUser` is `SELECT id FROM "User" WHERE id = ${userId} FOR UPDATE`.
- The module comment states the lock order: Organization row first, then Membership rows.
- `orgs/routes.ts` imports `lockOwnersAndTarget` from `./locks.js`. Behaviour is unchanged.

- [ ] **Step 4: Implement the two creation limits**

- `POST /v1/orgs`: move the create into `createOwnedOrg(slug)`, which runs `app.prisma.$transaction`:
  1. `lockUser`;
  2. read the caller's OWNER memberships with `org.plan`;
  3. compute `max = owned.length === 0 ? limitsFor('free').ownedOrgs : Math.max(...owned.map((m) => limitsFor(m.org.plan).ownedOrgs))`;
  4. if `owned.length >= max`, throw `new PlanLimitError('orgs', max)`;
  5. create the org.

  The existing P2002 slug retry calls `createOwnedOrg(retrySlug)` again, as a new transaction. Map `PlanLimitError` with `sendPlanLimit`.
- `GET /v1/orgs`: `rows.map((r) => ({ ...r.org, role: r.role, limits: limitsFor(r.org.plan) }))`.
- `POST /v1/orgs/:org/apps`: one transaction:
  1. `lockOrg`;
  2. the existing duplicate check → 409 (it stays before the limit, so the duplicate tests keep their 409);
  3. `tx.app.count({ where: { orgId } }) >= limitsFor(plan).apps` → `PlanLimitError('apps', max)`;
  4. create.

  Keep the P2002 → 409 catch around the transaction.

- [ ] **Step 5: Fix fixtures broken by the free limits, then run the API suite**

Known ones are `'never hands out a reserved slug'` and `'suffixes a colliding slug'`: after the first org is created, `prisma.organization.update({ data: { plan: 'team' } })`. Fix any other failure of this kind the same way.

Run: `caffeinate -i pnpm --filter @query-analyser/api test && pnpm --filter @query-analyser/api exec tsc --noEmit`
Expected: all PASS, no type errors.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src
git commit -m "feat(api): plan limits for creating organisations and apps"
```

---

### Task 2: API — `AppAccess` model, `Invite.appId`, migration with idempotent backfill

**Files:**
- Modify: `apps/api/prisma/schema.prisma`
- Create: `apps/api/prisma/migrations/<timestamp>_plans_and_app_access/migration.sql` (generated, then edited)
- Create: `apps/api/src/orgs/app-access-migration.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces (Prisma client, used by every later API task):
  - `prisma.appAccess` with fields `id, appId, userId, role: Role, createdAt`; unique `appId_userId`; relations `app` and `user`.
  - `Invite.appId: string | null` with relation `app`.
  - `App.access`, `App.invites`, and `User.appAccess`.

- [ ] **Step 1: Edit the schema**

```prisma
model AppAccess {
  id        String   @id @default(uuid())
  appId     String
  userId    String
  /// MEMBER or VIEWER only (CHECK constraint in the migration).
  role      Role
  createdAt DateTime @default(now()) @db.Timestamptz(3)
  app       App      @relation(fields: [appId], references: [id], onDelete: Cascade)
  user      User     @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@unique([appId, userId])
  @@index([userId])
}
```

- `Invite`: add `appId String?`, `app App? @relation(fields: [appId], references: [id], onDelete: Cascade)` and `@@index([appId])`.
- `App`: add `access AppAccess[]` and `invites Invite[]`. `User`: add `appAccess AppAccess[]`.

- [ ] **Step 2: Generate the migration**

Run: `pnpm --filter @query-analyser/api exec prisma migrate dev --create-only --name plans_and_app_access`
Expected: a new `prisma/migrations/<timestamp>_plans_and_app_access/migration.sql` with `CREATE TABLE "AppAccess"`, the `Invite.appId` column, indexes and foreign keys (`ON DELETE CASCADE`).

- [ ] **Step 3: Append the hand-written SQL to that `migration.sql`**

Follow the comment style of `20260920152948_hist_length_check`:

```sql
-- Prisma can't express a CHECK constraint. Per-app roles are MEMBER or VIEWER;
-- OWNER and ADMIN are org-wide and never have AppAccess rows.
ALTER TABLE "AppAccess" ADD CONSTRAINT "AppAccess_role_check" CHECK (role IN ('MEMBER'::"Role", 'VIEWER'::"Role"));

-- backfill:start
-- Nobody loses access on deploy: every MEMBER/VIEWER keeps every app their
-- org has today, with their membership role. Idempotent (ON CONFLICT) and a
-- no-op on an empty database.
INSERT INTO "AppAccess" ("id", "appId", "userId", "role", "createdAt")
SELECT gen_random_uuid()::text, a."id", m."userId", m."role", now()
FROM "Membership" m
JOIN "App" a ON a."orgId" = m."orgId"
WHERE m."role" IN ('MEMBER'::"Role", 'VIEWER'::"Role")
ON CONFLICT ("appId", "userId") DO NOTHING;
-- backfill:end
```

- [ ] **Step 4: Write the migration test** in `src/orgs/app-access-migration.test.ts`

The test reads the real SQL: it finds the directory ending `_plans_and_app_access` under `prisma/migrations`, slices between `-- backfill:start` and `-- backfill:end`, and runs it with `app.prisma.$executeRawUnsafe`. Harness: `buildApp({ logger: false })`, `resetDb` in `beforeEach`. Seed with `prisma.user/organization/membership/app.create`.

```ts
it('gives every MEMBER/VIEWER a row for every app in their org with their role; OWNER/ADMIN get none', async () => {
  // org A: OWNER o, ADMIN a, MEMBER m, VIEWER v; apps a1, a2. org B: app b1, m is not in it.
  await backfill();
  // rows: (a1,m,MEMBER) (a2,m,MEMBER) (a1,v,VIEWER) (a2,v,VIEWER) — exactly 4; none for o, a, or b1
});
it('is idempotent', async () => { /* run twice → still 4 rows; a row deleted by hand before the second run comes back */ });
it('is a no-op on an empty database', async () => { /* resetDb then backfill() resolves; count 0 */ });
it('refuses an ADMIN or OWNER AppAccess row', async () => {
  await expect(app.prisma.appAccess.create({ data: { appId, userId, role: 'ADMIN' } })).rejects.toThrow();
});
it('cascades: deleting an app removes its rows and its invites; deleting a user removes their rows', async () => {
  // invite with appId a1 and one with appId null; delete a1 → a1 rows and the a1 invite gone, the org-wide invite stays
});
```

- [ ] **Step 5: Apply the migration and run the test**

Run: `pnpm --filter @query-analyser/api exec prisma migrate deploy && pnpm --filter @query-analyser/api db:generate && pnpm --filter @query-analyser/api exec vitest run src/orgs/app-access-migration.test.ts`
Expected: the migration applies; all PASS.

- [ ] **Step 6: Run the API suite and typecheck**

Run: `caffeinate -i pnpm --filter @query-analyser/api test && pnpm --filter @query-analyser/api exec tsc --noEmit`
Expected: all PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/api/prisma apps/api/src/orgs/app-access-migration.test.ts
git commit -m "feat(api): AppAccess table and app-scoped invites, backfilling existing members"
```

---

### Task 3: API — `requireAppRole` and the app list honour `AppAccess`

**Files:**
- Modify: `apps/api/src/orgs/rbac.ts` (`requireAppRole`)
- Modify: `apps/api/src/apps/routes.ts` (`GET /v1/orgs/:org/apps`)
- Test: `apps/api/src/apps/routes.test.ts` (new `describe('per-app access')`)

**Interfaces:**
- Consumes: `prisma.appAccess` (Task 2).
- Produces:
  - `requireAppRole(min)` sets `req.membership = { orgId, role }`. Here `role` is the effective app role: the `AppAccess` role for MEMBER/VIEWER memberships, and the membership role for OWNER/ADMIN. It also sets `req.appId`.
  - `GET /v1/orgs/:org/apps` lists only apps with a row for MEMBER/VIEWER callers.

- [ ] **Step 1: Write the failing tests**

Add a helper `memberOf(orgId, role, email)`, which signs up, verifies, creates the membership and returns `{ id, h }`. The org gets two apps `shop` and `admin` (set plan `'team'`).

```ts
it('a MEMBER without a row gets the same 404 as a nonexistent app', async () => {
  // GET /v1/apps/:shop → statusCode and json() equal those of GET /v1/apps/00000000-0000-0000-0000-000000000000
});
it('a MEMBER with a row reads that app only', async () => { /* row on shop → shop 200, admin 404 */ });
it('the row role decides, not the membership role', async () => {
  // membership VIEWER + row MEMBER on shop → PATCH /v1/apps/:shop/alerts/<uuid> passes the MEMBER gate (404 Not Found for the alert)
  // membership MEMBER + row VIEWER → the same PATCH → 403 { error: 'insufficient role' }
});
it('OWNER and ADMIN need no row', async () => { /* both read shop and admin: 200 */ });
it('lists only accessible apps for MEMBER/VIEWER, every app for ADMIN', async () => {
  // MEMBER with row on shop → GET /v1/orgs/:org/apps → [shop]; with no rows → []; ADMIN → [shop, admin]
});
it('a member without access to an app in a suspended org gets 404, not 403 (Review Focus)', async () => {
  // suspend the org; MEMBER with no row → GET /v1/apps/:shop → 404 { error: 'Not Found' }
  // MEMBER with a row → 403 { error: 'organization suspended' } (unchanged)
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @query-analyser/api exec vitest run src/apps/routes.test.ts`
Expected: FAIL. Members read every app.

- [ ] **Step 3: Implement**

`requireAppRole`, in order:
1. find the membership, as today. Missing → 404.
2. If the membership role is MEMBER or VIEWER, `prisma.appAccess.findUnique({ where: { appId_userId: { appId, userId } }, select: { role: true } })`. Missing → 404. Otherwise the effective role is the row's role.
3. Suspended → 403.
4. `roleAtLeast(effective, min)` → else 403.

Update the doc comment with the new rule and why access is checked before suspension.

The app list adds `...(roleAtLeast(req.membership.role, 'ADMIN') ? {} : { access: { some: { userId: req.user.id } } })` to the `where`.

- [ ] **Step 4: Run the API suite and typecheck**

Run: `caffeinate -i pnpm --filter @query-analyser/api test && pnpm --filter @query-analyser/api exec tsc --noEmit`
Expected: all PASS. Existing tests that read apps as a seeded MEMBER/VIEWER need an `AppAccess` row in their fixture; add it there.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/orgs/rbac.ts apps/api/src/apps
git commit -m "feat(api): members and viewers see only the apps they were given"
```

---

### Task 4: API — creating invites: app scope, invitable roles, seats, the email names the app

**Files:**
- Create: `apps/api/src/orgs/seats.ts`
- Modify: `apps/api/src/orgs/invites.ts` (create and list; remove `MAX_PENDING_INVITES` and the owner-only check)
- Modify: `apps/api/src/mail/templates.ts` (`inviteEmail`), `apps/api/scripts/preview-emails.ts` (pass an `appName`)
- Test: `apps/api/src/orgs/invites.test.ts`, `apps/api/src/mail/templates.test.ts`

**Interfaces:**
- Consumes: `lockOrg`, `PlanLimitError`, `sendPlanLimit`, `limitsFor` (Task 1); `Invite.appId` (Task 2).
- Produces:
  - `seatState(db: Prisma.TransactionClient | PrismaClient, orgId: string, now?: Date): Promise<{ used: number; emails: Set<string> }>`. `emails` is lowercased member emails ∪ pending unexpired invite emails, and `used = emails.size − 1` (floored at 0).
  - `POST /v1/orgs/:org/invites`, body `{ email, role, appId? }`:
    - `201 { id, email, role, appId: string | null, expiresAt, token }`;
    - `400 { error: 'invalid body' }`: bad shape; MEMBER/VIEWER without `appId`; OWNER/ADMIN with one;
    - `403 plan-limit` `role` or `seats`;
    - `404 { error: 'Not Found' }`: `appId` not in this org.
  - `GET /v1/orgs/:org/invites` items gain `appId: string | null`.
  - `inviteEmail({ href, orgName, inviterName, role, ttlMs, appName?: string })`.

- [ ] **Step 1: Write the failing tests**

In `invites.test.ts`, change `orgWithOwner(name = 'A', plan = 'team')`: it creates the org through the API, sets `plan`, creates app `Shop` via `prisma.app.create`, and returns `{ o, org, appId }`. Convert inline `user('o@x.io') + POST /v1/orgs` setups to it. Every MEMBER/VIEWER invite payload gains `appId`. Replace the old OWNER test and the 50-cap test with:

```ts
describe('invite rules', () => {
  it('free: a MEMBER invite to an app is accepted; ADMIN and VIEWER are refused as role', async () => {
    const { o, org, appId } = await orgWithOwner('A', 'free');
    // MEMBER + appId → 201, json().appId === appId
    // ADMIN (no appId) → 403 { error: 'plan-limit', limit: 'role', max: 1 }; VIEWER + appId → same
  });
  it('OWNER is never invitable, on any plan', async () => { /* team → 403 { error: 'plan-limit', limit: 'role', max: 3 } */ });
  it('400s MEMBER/VIEWER without appId and ADMIN with one', async () => { /* three 400 { error: 'invalid body' } */ });
  it("404s another org's app and a nonexistent one alike", async () => { /* equal statusCode and json() */ });
  it('free: one seat; adding no person never needs one (Review Focus)', async () => {
    const { o, org, appId } = await orgWithOwner('A', 'free');
    // n1 → 201; n2 → 403 { error: 'plan-limit', limit: 'seats', max: 1 }
    // re-invite n1 (any case: 'N1@x.io') → 201; invite the owner's own email → 201
    // revoke both n1 invites → n2 → 201
  });
  it('removing a member frees the seat', async () => { /* member m seeded; n → 403 seats; DELETE member m → n → 201 */ });
  it('an org already over its seats keeps everyone but cannot add a new email', async () => { /* 2 members seeded on free → new email 403 seats; counts unchanged */ });
  it('two concurrent invites of new emails on free make exactly one invite', async () => { /* sorted [201, 403]; invite count 1 */ });
  it('lists appId on pending invites', async () => { /* one app invite, one ADMIN (team) → appIds [appId, null] in some order */ });
});
```

The `'429s the 11th invite…'` test keeps working on `'team'` (20 seats). In `describe('invite email')`, add:

```ts
it('names the app and the org', async () => {
  // MEMBER invite to Shop in org 'Acme' → last mail subject "You're invited to Shop in Acme on Query Analyser"; text contains 'invited you to Shop in Acme'
});
```

`templates.test.ts`: `inviteEmail({ …, appName: 'Shop <b>' })` → the html contains `Shop &lt;b&gt;`, the subject has no CR/LF, and without `appName` the existing output is unchanged.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @query-analyser/api exec vitest run src/orgs/invites.test.ts src/mail/templates.test.ts`
Expected: FAIL (no plan checks, no `appId`, no app name in mail).

- [ ] **Step 3: Implement `seatState` and the create route**

- `createSchema = z.object({ email: z.string().email().max(200), role: z.enum(ROLES), appId: z.string().min(1).max(64).nullish() })`.
- Before any DB work, return 400 `invalid body` when the role is MEMBER/VIEWER and `appId` is missing, or OWNER/ADMIN and `appId` is set.
- Then one `$transaction`:
  1. `lockOrg` (null → `NOT_FOUND`);
  2. `limitsFor(plan).invitableRoles.includes(role)`, else `PlanLimitError('role', invitableRoles.length)`;
  3. when `appId` is set: `tx.app.findFirst({ where: { id: appId, orgId } })`, missing → `NOT_FOUND`;
  4. `seatState(tx, orgId)`: when `!emails.has(email) && used >= limits.seats` → `PlanLimitError('seats', limits.seats)`;
  5. create the invite with `appId`, selecting `app: { select: { name: true } }` and `org: { select: { name: true } }`.

  The mail send stays after the transaction and passes `appName`.
- Delete `MAX_PENDING_INVITES`, the 409 and the owner-only 403. Update the comments that cite Ruling C9-1 (seats now bound pending invites).
- The list select adds `appId: true`.

- [ ] **Step 4: Implement `appName` in `inviteEmail`**

When `appName` is given:
- subject: `You're invited to ${app} in ${org} on Query Analyser`;
- preheader: `${inviter} invited you to ${app} in ${org} on Query Analyser.`;
- body: `<strong>inviter</strong> invited you to <strong>app</strong> in <strong>org</strong> as <strong>role</strong>, to see which MongoDB queries are slowing it down, and why.`;
- the text body uses the same sentence.

Escape and `oneLine` as the existing fields do. Without `appName`, the output is byte-identical to today. Add `appName: 'Shop'` to the invite preview in `scripts/preview-emails.ts`.

- [ ] **Step 5: Run the API suite and typecheck**

Run: `caffeinate -i pnpm --filter @query-analyser/api test && pnpm --filter @query-analyser/api exec tsc --noEmit`
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/orgs apps/api/src/mail apps/api/scripts
git commit -m "feat(api): app-scoped invites within the plan's roles and seats"
```

---

### Task 5: API — accepting an invite: membership, app access, legacy invites, consumed 409

**Files:**
- Modify: `apps/api/src/orgs/invites.ts` (`POST /v1/invites/:token/accept`)
- Test: `apps/api/src/orgs/invites.test.ts` (new `describe('accept')`, plus the two concurrency tests)

**Interfaces:**
- Consumes: `lockOrg`, `lockOwnersAndTarget` (Task 1); `prisma.appAccess`, `Invite.appId` (Task 2); `seatState` (Task 4).
- Produces: `POST /v1/invites/:token/accept` →
  - `200 { orgId: string; slug: string; role: Role; appId?: string }` (`appId` only for an app invite);
  - `404`, `410`, `403` (suspended, wrong email), as today;
  - `409 { error: 'already a member' }` when nothing changed. The invite is still marked accepted.

- [ ] **Step 1: Write the failing tests** (use `orgWithOwner`; add a second app `Admin panel` via prisma where needed)

```ts
describe('accept', () => {
  it('a new user joins as MEMBER with access to that app only', async () => {
    // accept → 200 { orgId, slug, role: 'MEMBER', appId }; membership MEMBER; rows: exactly [(appId, MEMBER)]
  });
  it('an app-scoped member invited to a second app keeps their membership and gains it with the invite role', async () => {
    // n is VIEWER with a row on Shop; invite n as MEMBER to Admin panel → 200; membership still VIEWER; rows Shop VIEWER + Admin panel MEMBER
  });
  it('the same access again is 409 and still consumes the invite (Review Focus)', async () => {
    // n MEMBER with a row on Shop (MEMBER); invite n MEMBER to Shop → accept → 409 { error: 'already a member' }
    // prisma.invite.findUnique(id).acceptedAt not null; GET /v1/orgs/:org/invites no longer lists it; a second accept → 410
  });
  it('a row with a different role is set to the invite role', async () => { /* row VIEWER; MEMBER invite → 200; row MEMBER */ });
  it('an OWNER or ADMIN accepting an app invite is 409 and the invite is consumed', async () => { /* … */ });
  it('an ADMIN invite promotes an existing MEMBER and drops their rows', async () => {
    // team; n MEMBER with rows on both apps; ADMIN invite → 200 role 'ADMIN', no appId; membership ADMIN; rows 0
  });
  it('a legacy MEMBER invite (appId null) grants every app in the org', async () => {
    // prisma.invite.create with appId null, role MEMBER, tokenHash of a known token → accept → rows for Shop and Admin panel
  });
  it('a legacy OWNER invite accepts as before', async () => { /* new user → membership OWNER, no rows; existing member → 409 */ });
  it('an invite to a deleted app 404s', async () => { /* prisma.app.delete → accept → 404 */ });
  it('waits on the org lock', async () => {
    // inside app.prisma.$transaction: lockOrg(tx, org.id); fire accept; settledOrBlocked(app.prisma, res, tx) === 'blocked'
  });
});
```

Rewrite `'409s one of two concurrent accepts of different invites…'` to use two MEMBER invites to the same app. Expect `[200, 409]`, 1 membership, 1 row and both invites accepted. `'404s an unknown token and 409s an existing member'`: the owner's self-invite carries `appId`. It still 409s.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @query-analyser/api exec vitest run src/orgs/invites.test.ts`
Expected: FAIL. An existing member 409s before anything, no rows are written, and `appId` is absent.

- [ ] **Step 3: Implement the accept transaction**

Keep the pre-checks (404, 410, suspended 403, email 403). Delete the `already` pre-check. In one `$transaction`:
1. `lockOrg(tx, inv.orgId)`.
2. Claim with the existing `updateMany`; `count === 0` → throw `InviteGoneError`.
3. `const { row } = await lockOwnersAndTarget(tx, inv.orgId, { userId })`.
4. Decide:
   - **Org-wide invite** (OWNER or ADMIN):
     - no row → create the membership with `inv.role`;
     - row is MEMBER/VIEWER and the invite is ADMIN → update it to ADMIN and `tx.appAccess.deleteMany({ where: { userId, app: { orgId } } })`;
     - otherwise → `ALREADY`.
   - **App invite or legacy MEMBER/VIEWER invite:**
     - targets are `[inv.appId]`, or every app id in the org when `appId` is null;
     - the row is OWNER/ADMIN → `ALREADY`;
     - no row → create the membership with `inv.role`;
     - then, for each target, create the row if missing, or update it if its role differs. If no row was created or changed and the membership existed before → `ALREADY`.
5. Return `ALREADY` (a module-level `Symbol`, not a throw, so the claim commits) or `{ orgId, slug, role: inv.role, ...(inv.appId ? { appId: inv.appId } : {}) }`.

Outside the transaction, `ALREADY` → `409 { error: 'already a member' }`. Keep the P2002 → 409 catch. Update the route's comments to match the new rules.

- [ ] **Step 4: Run the API suite and typecheck**

Run: `caffeinate -i pnpm --filter @query-analyser/api test && pnpm --filter @query-analyser/api exec tsc --noEmit`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/orgs/invites.ts apps/api/src/orgs/invites.test.ts
git commit -m "feat(api): accepting an invite grants app access, honouring legacy invites"
```

---

### Task 6: API — role changes, member removal and the members list keep `AppAccess` in step

**Files:**
- Modify: `apps/api/src/orgs/routes.ts` (`PATCH /v1/orgs/:org/members/:id`, `removeMembership`, `GET /v1/orgs/:org/members`)
- Test: `apps/api/src/orgs/routes.test.ts`

**Interfaces:**
- Consumes: `lockOrg`, `lockOwnersAndTarget`, `limitsFor`, `PlanLimitError`, `sendPlanLimit` (Task 1); `prisma.appAccess` (Task 2).
- Produces:
  - `PATCH` may answer `403 plan-limit` `role` (`max` = invitable roles count). Its success body is unchanged: `{ id, role }`.
  - `GET /v1/orgs/:org/members` items: `{ id, role, createdAt, user: { id, email, name }, allApps: boolean, apps: { id: string; name: string; role: Role }[] }`. OWNER/ADMIN have `allApps: true, apps: []`. Apps are ordered by app `createdAt`.

- [ ] **Step 1: Write the failing tests** in a new `describe('roles and app access')`

```ts
it('free: a member can only be made OWNER; ADMIN and VIEWER are refused as role', async () => {
  // PATCH role ADMIN → 403 { error: 'plan-limit', limit: 'role', max: 1 }; VIEWER → same; OWNER → 200
});
it('setting the current role is always allowed (grandfathered VIEWER on free)', async () => { /* VIEWER → VIEWER → 200 */ });
it('promotion to ADMIN or OWNER drops their rows in this org only', async () => {
  // team; m has rows on two apps here and one in another org → PATCH ADMIN → rows here 0, other org 1
});
it('demotion to MEMBER grants every current app with the new role', async () => {
  // team; ADMIN with no rows, org has 2 apps → PATCH MEMBER → 2 rows, both MEMBER
});
it('MEMBER → VIEWER moves every row to VIEWER', async () => { /* team; rows on 2 apps */ });
it('being made OWNER ignores the target\'s owned-org limit', async () => {
  // free target already owns their own org → PATCH OWNER in this org → 200
});
it('removing a member and leaving both delete their rows in that org', async () => { /* both paths → rows 0 */ });
it('lists each member with their apps', async () => {
  // GET members → owner { allApps: true, apps: [] }; m { allApps: false, apps: [{ id, name: 'Shop', role: 'MEMBER' }] }
});
```

The existing role-change tests that promote to ADMIN or VIEWER set the org's plan to `'team'` first.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @query-analyser/api exec vitest run src/orgs/routes.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

- `PATCH`, inside the existing transaction:
  1. `const org = await lockOrg(tx, orgId)` first;
  2. `lockOwnersAndTarget` and the last-owner check (unchanged);
  3. when `role !== row.role && role !== 'OWNER' && !limits.invitableRoles.includes(role)` → `PlanLimitError('role', n)`;
  4. update the role;
  5. then, by transition:
     - MEMBER/VIEWER → OWNER/ADMIN: `deleteMany` their rows where `app: { orgId }`;
     - OWNER/ADMIN → MEMBER/VIEWER: `createMany` a row for every app in the org with the new role, `skipDuplicates: true`;
     - MEMBER ↔ VIEWER: `updateMany` their rows in the org to the new role.

  Map `PlanLimitError` with `sendPlanLimit`.
- `removeMembership`: after the delete, `tx.appAccess.deleteMany({ where: { userId: row.userId, app: { orgId } } })`.
- Members list: select `user.appAccess` filtered to `app: { orgId }`, with `app { id, name, createdAt }` and `role`. Map to `allApps` / `apps`.

- [ ] **Step 4: Run the API suite and typecheck**

Run: `caffeinate -i pnpm --filter @query-analyser/api test && pnpm --filter @query-analyser/api exec tsc --noEmit`
Expected: all PASS, including the existing `settledOrBlocked` lock tests.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/orgs/routes.ts apps/api/src/orgs/routes.test.ts
git commit -m "feat(api): role changes and removals keep per-app access in step"
```

---

### Task 7: API — list and revoke an app's access; delete an app

**Files:**
- Create: `apps/api/src/apps/access.ts` (registered from `appRoutes`, like `sampleKeyRoutes`)
- Modify: `apps/api/src/apps/routes.ts` (`DELETE /v1/apps/:id`)
- Create: `apps/api/src/apps/access.test.ts`

**Interfaces:**
- Consumes: `requireAppRole` (Task 3), `seatState` (Task 4), `limitsFor`, `lockOrg` (Task 1), and `app.keys.invalidate(hash)`.
- Produces:
  - `GET /v1/apps/:id/access` (ADMIN+) → `200 { people, invites, seats }`:
    - `people: { userId: string; name: string; email: string; role: Role; allApps: boolean }[]` (OWNER/ADMIN first by membership `createdAt`, then row holders by row `createdAt`);
    - `invites: { id: string; email: string; role: Role; expiresAt: string }[]` (pending, unexpired, this app only);
    - `seats: { used: number; max: number }`.
  - `DELETE /v1/apps/:id/access/:userId` (ADMIN+) → 204, or `404 { error: 'Not Found' }` when there is no row.
  - `DELETE /v1/apps/:id` (ADMIN+) → 204.

- [ ] **Step 1: Write the failing tests** in `apps/access.test.ts` (same harness and helpers as `apps/routes.test.ts`; org plan `'team'` unless stated)

```ts
describe('GET /v1/apps/:id/access', () => {
  it('lists owners/admins as all-apps, row holders, this app\'s pending invites and seats', async () => {
    // owner o, admin a, member m (row on shop), viewer v (row on other app only)
    // invites: n1 → shop pending; n2 → other app; n3 → shop expired; n4 → org-wide ADMIN
    expect(res.json()).toEqual({
      people: [
        { userId: o.id, name: 'o@x.io', email: 'o@x.io', role: 'OWNER', allApps: true },
        { userId: a.id, name: 'a@x.io', email: 'a@x.io', role: 'ADMIN', allApps: true },
        { userId: m.id, name: 'm@x.io', email: 'm@x.io', role: 'MEMBER', allApps: false },
      ],
      invites: [{ id: n1Id, email: 'n1@x.io', role: 'MEMBER', expiresAt: expect.any(String) }],
      seats: { used: 6, max: 20 }, // o a m v + n1 n2 n4 − 1 (n3 expired)
    });
  });
  it('403s a MEMBER with a row and 404s one without', async () => { /* … */ });
});
describe('DELETE /v1/apps/:id/access/:userId', () => {
  it('removes the row only; the membership stays and still counts as a seat', async () => { /* 204; row gone; membership present; seats.used unchanged */ });
  it('404s when there is no row, including for an OWNER', async () => { /* … */ });
});
describe('DELETE /v1/apps/:id', () => {
  it('deletes the app with its keys, signatures, rows and app invites; org-wide invites and memberships stay', async () => { /* 204; counts */ });
  it('its ingest key is refused at once (Review Focus)', async () => {
    // create key; POST /v1/ingest → 202 (warms the KeyResolver cache); DELETE app → 204; POST /v1/ingest → 401
  });
  it('403s a MEMBER, 404s a foreign or unknown app alike', async () => { /* … */ });
  it('frees the free plan\'s app slot', async () => { /* free: delete the only app → POST /v1/orgs/:org/apps → 201 */ });
});
```

Copy the ingest body from `'revokes a key and the ingest route rejects it immediately'` in `apps/routes.test.ts`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @query-analyser/api exec vitest run src/apps/access.test.ts`
Expected: FAIL with 404s (the routes don't exist).

- [ ] **Step 3: Implement**

- `access.ts` `accessRoutes(app)`. Both routes use `[app.authenticate, app.requireVerified, requireAppRole('ADMIN')]`.
  - GET: OWNER/ADMIN memberships of `req.membership.orgId` with `user`, the `appAccess` rows for `req.appId` with `user`, pending invites `{ appId: req.appId, acceptedAt: null, expiresAt: { gt: now } }`, and `seatState` + `limitsFor(plan).seats`.
  - DELETE: `deleteMany({ where: { appId: req.appId, userId } })`; `count === 0` → 404.
- `DELETE /v1/apps/:id` in `routes.ts`, in one transaction:
  1. `lockOrg(tx, req.membership.orgId)`;
  2. read the app's key hashes (`tx.ingestKey.findMany({ where: { appId }, select: { keyHash: true } })`);
  3. `tx.app.delete`.

  After commit, call `app.keys.invalidate(hash)` for each hash, then reply 204. The cascades from Task 2 remove the rows and invites.

- [ ] **Step 4: Run the API suite and typecheck**

Run: `caffeinate -i pnpm --filter @query-analyser/api test && pnpm --filter @query-analyser/api exec tsc --noEmit`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/apps
git commit -m "feat(api): list and revoke app access, and delete an app"
```

---

### Task 8: API — daily retention per org plan

**Files:**
- Modify: `apps/api/src/analysis/compaction.ts` (replace `pruneDaily` with `pruneDailyByPlan`)
- Modify: `apps/api/src/analysis/jobs.ts` (drop `DAILY_RETENTION_DAYS`, call `pruneDailyByPlan`)
- Test: `apps/api/src/analysis/compaction.test.ts`, `apps/api/src/analysis/jobs.test.ts`

**Interfaces:**
- Consumes: `PLAN_LIMITS`, `limitsFor` (Task 1).
- Produces: `pruneDailyByPlan(prisma: PrismaClient, now: Date): Promise<number>`. It deletes daily rollups strictly older than `now − dailyRetentionDays` of the owning org's plan, with unknown plans treated as free. It returns the total deleted.

- [ ] **Step 1: Write the failing tests**

`compaction.test.ts`, replacing the `pruneDaily` test:

```ts
it('prunes daily rollups by each org plan', async () => {
  // now = 2026-10-20T02:00Z; orgs on 'free', 'pro', 'team', 'legacy-unknown', one signature each
  // daily rows per org at now−6d, now−8d, now−29d, now−31d, now−89d, now−91d (UTC midnights)
  // free and unknown keep only −6d; pro keeps −6d, −8d, −29d; team keeps all but −91d
  expect(deleted).toBe(5 + 5 + 3 + 1);
});
```

`jobs.test.ts`: in the `vi.mock('./compaction.js')` factory, replace `pruneDaily` with `pruneDailyByPlan: vi.fn(async () => 0)`, and in `beforeEach` likewise. Rename `'prunes hourly at 7 days and daily at 90 days from now'` to `'prunes hourly at 7 days and daily by plan'`. It asserts `pruneHourly` got `2026-09-13T00:00:00.000Z` and `pruneDailyByPlan` was called with `(app.prisma, now)`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @query-analyser/api exec vitest run src/analysis/compaction.test.ts src/analysis/jobs.test.ts`
Expected: FAIL (no `pruneDailyByPlan`).

- [ ] **Step 3: Implement**

Issue one `queryDailyRollup.deleteMany` per known plan: `{ day: { lt: daysAgo(now, d) }, signature: { app: { org: { plan } } } }`. Then one more for `{ plan: { notIn: Object.keys(PLAN_LIMITS) } }` at the free cutoff. Sum the counts. `jobs.ts` replaces its `pruneDaily` call. Keep the prune-last ordering and its comment, and update the "90-day" wording in that comment.

- [ ] **Step 4: Run the API suite and typecheck**

Run: `caffeinate -i pnpm --filter @query-analyser/api test && pnpm --filter @query-analyser/api exec tsc --noEmit`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/analysis
git commit -m "feat(api): keep daily data for as long as the org's plan allows"
```

---

### Task 9: Web — plan-limit plumbing, BFF routes for access and app delete, invite accept lands on the app

**Files:**
- Modify: `apps/web/src/api.ts` (failure gains `limit`), `apps/web/src/api.test.ts`
- Modify: `apps/web/src/dashboard-types.ts`, `apps/web/src/dashboard-api.ts`
- Create: `apps/web/src/plan-limits.ts`, `apps/web/src/plan-limits.test.ts`
- Modify: `apps/web/src/org-bff.ts` (`planLimitResponse`)
- Modify: `apps/web/app/api/onboarding/org/route.ts`, `apps/web/app/api/onboarding/app/route.ts`, `apps/web/src/onboarding-routes.test.ts`
- Modify: `apps/web/app/api/orgs/[org]/invites/route.ts`, `apps/web/app/api/orgs/[org]/members/[id]/route.ts`, `apps/web/app/api/invites/accept/route.ts`, `apps/web/src/invite-routes.test.ts`
- Create: `apps/web/app/api/apps/[id]/route.ts`, `apps/web/app/api/apps/[id]/access/route.ts`, `apps/web/app/api/apps/[id]/access/[userId]/route.ts`, `apps/web/src/app-access-routes.test.ts`
- Modify: `apps/web/app/_components/AcceptInviteClient.tsx`, `apps/web/src/accept-invite-client.test.tsx`

**Interfaces:**
- Consumes: the API shapes from Tasks 1 and 4–7.
- Produces:
  - `ApiResult` failure: `{ ok: false; status; code?; error; limit?: string }`.
  - `dashboard-types.ts`:
    - `PlanLimits` (the same fields as the API);
    - `OrgSummary` gains `limits: PlanLimits`;
    - `MemberApp = { id: string; name: string; role: Role }`;
    - `Member` gains `allApps: boolean; apps: MemberApp[]`;
    - `PendingInvite` gains `appId: string | null`;
    - `AppPerson = { userId: string; name: string; email: string; role: Role; allApps: boolean }`;
    - `AppAccessList = { people: AppPerson[]; invites: Omit<PendingInvite, 'createdAt' | 'appId'>[]; seats: { used: number; max: number } }`.
  - `dashboard-api.ts`: `getAppAccess(t: string, appId: string): Promise<ApiResult<AppAccessList>>`.
  - `plan-limits.ts`:
    - `type LimitKind`;
    - `PLAN_LIMIT_COPY: Record<LimitKind, string>` (the four strings verbatim);
    - `planLimitCopy(limit: unknown): string | null`;
    - `canCreateOrg(orgs: { role: Role; limits: PlanLimits }[]): boolean` (true when the user owns none; else owned count < max `ownedOrgs` over owned);
    - `canCreateApp(limits: PlanLimits, appCount: number): boolean`;
    - `retentionNote(days: number): string` → `Kept for ${days} days on your plan`;
    - `seatsLabel(s: { used: number; max: number }): string` → `${used} of ${max} seats used`;
    - `appAccessSummary(m: { allApps: boolean; apps: MemberApp[] }): string` → `'All apps'`, `'No apps'`, or role groups in `ROLES` order such as `'Member · Shop, Admin panel; Viewer · Docs'`.
  - `org-bff.ts`: `planLimitResponse(res: { status: number; error: string; limit?: string }): Response | null`. It returns `403 { error: copy, limit }` (no-store) for a known plan-limit, else null.
  - BFF:
    - `POST /api/orgs/[org]/invites` forwards `{ email, role, appId? }`. `appId` must pass `isSafeSegment` when present.
    - `DELETE /api/apps/[id]` → 204 plus `Set-Cookie: qa_last_app=; Path=/dashboard; Max-Age=0`.
    - `GET /api/apps/[id]/access` → `AppAccessList` (allowlisted fields only).
    - `DELETE /api/apps/[id]/access/[userId]` → 204.
    - Accept → `200 { orgId, slug?, appId? }`.

Fixed BFF copy:
- App delete: 403 `'Only workspace admins can delete apps.'`, 404 `'That app no longer exists.'`.
- Access list: 403 `'Only workspace admins can see who has access.'`, 404 `'That app no longer exists.'`.
- Revoke access: 403 `'Only workspace admins can remove access.'`, 404 `'That person no longer has access to this app.'`.
- Invites 400: `'Enter a valid email address and choose a role.'` (unchanged), 404 `'That app no longer exists.'`.
- 401 → `'unauthorized'`, 429 → `safeUpstreamMessage(429, 'generic')`, anything else → 502 `safeUpstreamMessage(status, 'generic')`.

- [ ] **Step 1: Write the failing tests**

`plan-limits.test.ts`:

```ts
it('maps each limit to its copy and ignores unknown ones', () => {
  expect(planLimitCopy('apps')).toBe('During the beta, each organisation has one app. Delete it to connect a different one, or upgrade later.');
  expect(planLimitCopy('nope')).toBeNull();
  expect(planLimitCopy(undefined)).toBeNull();
});
it('canCreateOrg: anyone who owns none; else fewer than the largest owned limit', () => {
  const free = limits(1), team = limits(3);
  expect(canCreateOrg([])).toBe(true);
  expect(canCreateOrg([{ role: 'MEMBER', limits: free }])).toBe(true);
  expect(canCreateOrg([{ role: 'OWNER', limits: free }])).toBe(false);
  expect(canCreateOrg([{ role: 'OWNER', limits: free }, { role: 'OWNER', limits: team }])).toBe(true);
});
it('labels', () => {
  expect(retentionNote(7)).toBe('Kept for 7 days on your plan');
  expect(seatsLabel({ used: 1, max: 1 })).toBe('1 of 1 seats used');
  expect(appAccessSummary({ allApps: false, apps: [{ id: '1', name: 'Shop', role: 'MEMBER' }, { id: '2', name: 'Admin panel', role: 'MEMBER' }] })).toBe('Member · Shop, Admin panel');
  expect(appAccessSummary({ allApps: true, apps: [] })).toBe('All apps');
  expect(appAccessSummary({ allApps: false, apps: [] })).toBe('No apps');
});
```

`api.test.ts`: a 403 body `{ error: 'plan-limit', limit: 'seats', max: 1 }` gives `{ ok: false, status: 403, error: 'plan-limit', limit: 'seats' }`.

`invite-routes.test.ts`:
- `POST` forwards `{ email, role, appId: 'app1' }` exactly (extra keys dropped);
- an `appId` of `'..'` → 400 with upstream untouched;
- an upstream `{ status: 403, error: 'plan-limit', limit: 'seats' }` → 403 `{ error: 'During the beta, you can invite one teammate. More seats with paid plans.', limit: 'seats' }`;
- a members `PATCH` refused as role → the role copy;
- accept passes `appId` through only when it is a safe segment.

`onboarding-routes.test.ts`: an org create refused as `orgs` and an app create refused as `apps` each return 403 with the copy and `limit`.

`app-access-routes.test.ts` (harness of `invite-routes.test.ts`):

```ts
it('every new route 403s cross-site and 401s without a session, with no-store', async () => { /* DELETE app, GET access, DELETE access */ });
it('rejects unsafe id and userId segments with 400', async () => { /* … */ });
it('DELETE app → 204, clears qa_last_app', async () => {
  // call()[0] === '/v1/apps/app1', method DELETE; set-cookie qa_last_app with Path=/dashboard and Max-Age=0
});
it('GET access passes only allowlisted fields', async () => {
  // upstream people entries carry an extra 'passwordHash' key → absent in the response; seats preserved
});
it('DELETE access → /v1/apps/app1/access/u1; 404 → its copy', async () => { /* … */ });
```

`accept-invite-client.test.tsx`: a reply `{ orgId: 'org1', slug: 'acme', appId: 'a1' }` → `router.replace('/dashboard/acme/a1/queries')`. Without `appId` it stays `'/dashboard/acme'`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @query-analyser/web exec vitest run src/plan-limits.test.ts src/api.test.ts src/invite-routes.test.ts src/onboarding-routes.test.ts src/app-access-routes.test.ts src/accept-invite-client.test.tsx`
Expected: FAIL (modules and fields missing).

- [ ] **Step 3: Implement the types, `plan-limits.ts`, `apiFetch` and `planLimitResponse`**

`apiFetch` reads `limit` only when `typeof body.limit === 'string'`. Fix typed fixtures across the web tests that build `OrgSummary`, `Member` or `PendingInvite` by adding the new fields.

- [ ] **Step 4: Implement the BFF changes and the three new handlers**

- Each failure mapper tries `planLimitResponse(res)` before its status switch.
- In the invites route, delete `OWNER_ONLY` and `CAP` and their branches, since the API no longer sends them.
- The onboarding routes add the plan-limit branch before their existing `safeUpstreamMessage` reply, and their responses gain `NO_STORE` headers.
- `AcceptInviteClient`: `router.replace(slug ? (appId ? appPath(slug, appId) : orgPath(slug)) : '/dashboard')`.

- [ ] **Step 5: Run the web suite and typecheck**

Run: `pnpm --filter @query-analyser/web test && pnpm --filter @query-analyser/web exec tsc --noEmit`
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src apps/web/app/api apps/web/app/_components/AcceptInviteClient.tsx
git commit -m "feat(web): plan-limit copy and BFF routes for app access and app deletion"
```

---

### Task 10: Web — Settings for admins only; limits in the switcher, org home, account and range

**Files:**
- Modify: `apps/web/components/dashboard/Sidebar.tsx`, `Sidebar.test.tsx`
- Modify: `apps/web/components/dashboard/AppSwitcher.tsx`, `AppSwitcher.test.tsx`
- Modify: `apps/web/components/dashboard/OrgHome.tsx`, `OrgHome.test.tsx`, `apps/web/app/dashboard/[org]/page.tsx`, `apps/web/src/org-home-page.test.tsx`
- Modify: `apps/web/components/account/OrganisationsCard.tsx`, `OrganisationsCard.test.tsx`, `apps/web/app/dashboard/account/page.tsx`
- Modify: `apps/web/app/dashboard/[org]/[app]/layout.tsx`
- Modify: `apps/web/app/dashboard/[org]/[app]/settings/page.tsx` (the `notFound()` gate only), and create `apps/web/src/settings-page.test.tsx`
- Modify: `apps/web/src/range.ts`, `apps/web/src/range.test.ts`, `apps/web/src/filters.ts`, `apps/web/components/dashboard/RangeControl.tsx`, create `apps/web/components/dashboard/RangeControl.test.tsx`
- Modify: `apps/web/app/dashboard/[org]/[app]/queries/page.tsx`, `apps/web/app/dashboard/[org]/[app]/queries/[sig]/page.tsx`

**Interfaces:**
- Consumes: `canCreateOrg`, `canCreateApp`, `PLAN_LIMIT_COPY`, `retentionNote` (Task 9); `OrgSummary.limits` (Task 9); `isAdminRole`.
- Produces:
  - `SidebarNav({ base, showSettings }: { base: string; showSettings: boolean })`;
  - `AppSwitcher` props: `newApp: { href: string; blocked: string | null } | null` replaces `newAppHref`, plus `newOrgBlocked: string | null`;
  - `OrgHome` gains `canCreateOrg: boolean`;
  - `OrganisationsCard` gains `canCreateOrg: boolean`;
  - `range.ts`: `PRESET_DAYS: Record<RangePreset, number>` and `presetAllowed(p: RangePreset, retentionDays: number): boolean` (days ≤ retention);
  - `parseRange(p, retentionDays = Infinity)`: a preset that isn't allowed → the 24h default;
  - `parseFilters(p, retentionDays?)` passes it through;
  - `RangeControl({ value, retentionDays }: { value: RangeState; retentionDays: number })`.

A blocked create control is never a link. It renders with `aria-disabled="true"` and shows its copy as visible `text-xs text-muted-foreground` helper text.

- [ ] **Step 1: Write the failing tests**

```ts
// Sidebar.test.tsx
it('hides Settings when showSettings is false', () => {
  render(<SidebarNav base="/dashboard/o/a" showSettings={false} />);
  expect(screen.queryByRole('link', { name: /Settings/ })).toBeNull();
  expect(screen.getByRole('link', { name: /Queries/ })).toBeTruthy();
});

// AppSwitcher.test.tsx: open() passes newApp and newOrgBlocked
it('a blocked New app stays visible, disabled, with the apps copy and no link', () => {
  open({ href: '/onboarding?org=o', blocked: PLAN_LIMIT_COPY.apps });
  expect(screen.getByText('New app').closest('a')).toBeNull();
  expect(screen.getByText('New app').closest('[aria-disabled="true"]')).toBeTruthy();
  expect(screen.getByText(PLAN_LIMIT_COPY.apps)).toBeTruthy();
});
it('a blocked New organisation likewise shows the orgs copy', () => { /* … */ });

// OrgHome.test.tsx
it('a member who cannot create an org sees the button disabled with the orgs copy', () => {
  // canCreateOrg false → no link 'Create your own organisation'; aria-disabled element with that text; orgs copy shown
});

// OrganisationsCard.test.tsx
it('Create organisation is disabled with the orgs copy when the limit is reached', () => { /* … */ });

// settings-page.test.tsx: mock @/src/shell-context getShellContext, @/src/dashboard-api, next/navigation notFound throwing 'NOT_FOUND'
it.each(['MEMBER', 'VIEWER'] as const)('a %s gets the not-found page and no settings data is fetched', async (role) => {
  await expect(page()).rejects.toThrow('NOT_FOUND');
  expect(getSampleKey).not.toHaveBeenCalled();
});

// range.test.ts
it('a preset longer than retention falls back to 24h (Review Focus)', () =>
  expect(parseRange({ range: '30d' }, 7)).toEqual({ kind: 'preset', preset: '24h' }));
it('a preset within retention is kept', () => expect(parseRange({ range: '7d' }, 7)).toEqual({ kind: 'preset', preset: '7d' }));

// RangeControl.test.tsx (mock next/navigation useRouter/usePathname/useSearchParams)
it('disables presets longer than the plan keeps and says why', () => {
  render(<RangeControl value={{ kind: 'preset', preset: '24h' }} retentionDays={7} />);
  expect((screen.getByRole('radio', { name: '30d' }) as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByRole('radio', { name: '7d' }) as HTMLButtonElement).disabled).toBe(false);
  expect(screen.getByText('Kept for 7 days on your plan')).toBeTruthy();
});
```

`org-home-page.test.tsx`: the `ORGS` fixtures gain `limits`. The page passes `canCreateOrg={canCreateOrg(orgs)}`. The OWNER-of-a-free-org fixture renders the disabled state.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @query-analyser/web exec vitest run components/dashboard components/account src/range.test.ts src/settings-page.test.tsx src/org-home-page.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement**

- `SidebarNav`: filter the `settings` link on `showSettings`.
- Layout:
  - `showSettings={isAdminRole(currentOrg.role)}`;
  - `newApp` is `isAdminRole(...) ? { href, blocked: canCreateApp(currentOrg.limits, (appsByOrg[org] ?? []).length) ? null : PLAN_LIMIT_COPY.apps } : null`;
  - `newOrgBlocked` is `canCreateOrg(orgs) ? null : PLAN_LIMIT_COPY.orgs`.
- `AppSwitcher`: a blocked item is `<CommandItem disabled value="new-app">` with the label and the copy, and no `Link`.
- Settings page: `if (!isAdminRole(ctx.currentOrg.role)) notFound();` right after `getShellContext`, before any fetch. Delete the now-dead `canManage` branching there; Task 11 rebuilds the page body.
- `RangeControl`: disabled `ToggleGroupItem` for presets that aren't allowed, with `title={retentionNote(d)}`. When any preset is disabled, render one `<p className="text-xs text-muted-foreground">` with `retentionNote(retentionDays)`. The calendar also disables days before `retentionDays` ago.
- Queries pages: `parseFilters(sp, ctx.currentOrg.limits.dailyRetentionDays)` / `parseRange(…, days)`, and `<RangeControl retentionDays={…} />`.
- Account page: pass `canCreateOrg={canCreateOrg(orgsRes.data)}`.

- [ ] **Step 4: Run the web suite, typecheck and build**

Run: `pnpm --filter @query-analyser/web test && pnpm --filter @query-analyser/web exec tsc --noEmit && pnpm --filter @query-analyser/web build`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/components apps/web/app/dashboard apps/web/src
git commit -m "feat(web): admin-only settings and plan limits in the dashboard"
```

---

### Task 11: Web — App Settings: People with access, org Members with apps, Danger zone

**Files:**
- Create: `apps/web/components/settings/People.tsx`, `People.test.tsx`
- Create: `apps/web/components/settings/DeleteApp.tsx`, `DeleteApp.test.tsx`
- Modify: `apps/web/components/settings/Members.tsx`, `Members.test.tsx`
- Modify: `apps/web/app/dashboard/[org]/[app]/settings/page.tsx`, `apps/web/src/settings-page.test.tsx`

**Interfaces:**
- Consumes:
  - `getAppAccess`, `AppAccessList`, `Member.apps/allApps`, `PendingInvite.appId` (Task 9);
  - `seatsLabel`, `appAccessSummary` (Task 9);
  - the BFF routes `POST /api/orgs/[org]/invites`, `DELETE /api/orgs/[org]/invites/[id]`, `GET /api/apps/[id]/access`, `DELETE /api/apps/[id]/access/[userId]` and `DELETE /api/apps/[id]` (Task 9);
  - `orgPath`.
- Produces:
  - `People({ orgId, appId, invitableRoles, initial }: { orgId: string; appId: string; invitableRoles: readonly Role[]; initial: AppAccessList | null })`;
  - `DeleteApp({ appId, appName, orgSlug }: { appId: string; appName: string; orgSlug: string })`;
  - `Members` props: `{ orgId, viewerRole, viewerUserId, invitableRoles, initialMembers, initialInvites }` (the invites are org-wide only).

- [ ] **Step 1: Write the failing tests** (jsdom, `fetch` stubbed with `reply()` from `Members.test.tsx`, `next/navigation` mocked with `router = { replace: vi.fn(), refresh: vi.fn() }`)

`People.test.tsx`:

```ts
const list: AppAccessList = {
  people: [
    { userId: 'u-o', name: 'Olu', email: 'o@x.co', role: 'OWNER', allApps: true },
    { userId: 'u-m', name: 'Mo', email: 'm@x.co', role: 'MEMBER', allApps: false },
  ],
  invites: [{ id: 'i1', email: 'n@x.co', role: 'MEMBER', expiresAt: '2026-10-27T00:00:00Z' }],
  seats: { used: 1, max: 1 },
};
it('shows the heading, seats, people and pending invites', () => {
  // heading 'People with access'; text '1 of 1 seats used'; 'All apps' badge for Olu with no Remove; button 'Remove m@x.co’s access'
});
it('free: the role select offers Member only, pre-selected', () => {
  // invitableRoles ['MEMBER'] → select 'Role' has exactly one option, value MEMBER
});
it('invites to this app, then reloads the list', async () => {
  // POST /api/orgs/org1/invites body { email: 'p@x.co', role: 'MEMBER', appId: 'app1' } → 201 { inviteLink }
  // then GET /api/apps/app1/access; status shows the link; new seats text rendered
});
it('shows the seats copy from the BFF in an alert', async () => { /* 403 { error: seats copy } → alert text */ });
it('removes access only after confirming, then focuses the heading', async () => {
  // click Remove → fetch not called → confirm 'Remove access' → DELETE /api/apps/app1/access/u-m → row gone; activeElement is the heading
});
it('revokes a pending invite', async () => { /* DELETE /api/orgs/org1/invites/i1 → row gone */ });
```

`DeleteApp.test.tsx`:

```ts
it('enables Delete only when the exact app name is typed', () => {
  // open dialog → confirm button disabled; type 'shop' (wrong case) → disabled; type 'Shop' → enabled
});
it('deletes and goes to the org home', async () => {
  // DELETE /api/apps/app1 → 204 → router.replace('/dashboard/acme')
});
it('shows the BFF error and stays', async () => { /* 403 → alert; router.replace not called */ });
```

`Members.test.tsx`:
- remove the MEMBER/VIEWER describe (the page no longer renders `Members` for them);
- `renderAs` passes `invitableRoles`;
- add:

```ts
it('shows each member\'s apps', () => { /* Ada (apps Shop MEMBER) → text 'Member · Shop'; owner → 'All apps' */ });
it('free: the role select offers Owner and Member only', () => { /* options ['Owner', 'Member'] */ });
it('has no per-app invite form; on free there is no admin invite either', () => { /* no 'Send invite' */ });
it('on pro, invites an admin org-wide', async () => { /* POST body { email, role: 'ADMIN' } */ });
```

`settings-page.test.tsx`: an ADMIN renders the sections in this order: 'People with access', 'Members', 'Real-value samples', 'Danger zone'. `getAppAccess` is called with the app id. Only invites with `appId === null` reach `Members`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @query-analyser/web exec vitest run components/settings src/settings-page.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement `People` and `DeleteApp`**

Follow `Members.tsx` patterns (Card + `h2` with `ref`/`tabIndex={-1}`, `refreshSession()` on 401, `AlertDialog` confirms, busy state, `focusTo`).

`People`:
- the role options are `invitableRoles.filter((r) => r === 'MEMBER' || r === 'VIEWER')`, defaulting to `MEMBER`;
- after an invite or a revoke, re-read `GET /api/apps/${appId}/access`, and keep the current state if that fails;
- the success notice and copyable link match `Members`.

`DeleteApp`:
- a Card headed "Danger zone" with a destructive "Delete app" button;
- the dialog title is `Delete ${appName}?`, the description "This deletes its keys, queries and samples, and removes everyone's access to it. This can't be undone.", the input label `Type ${appName} to confirm`, and the action "Delete app";
- the action is a `Button` (not `AlertDialogAction`) so the dialog stays open on error;
- on 204, `router.replace(orgPath(orgSlug))` then `router.refresh()`.

- [ ] **Step 4: Update `Members` and the settings page**

`Members`:
- drop the `!canManage` branch;
- the role select's options are `ROLES.filter((r) => r === 'OWNER' || invitableRoles.includes(r) || r === m.role)`;
- each row shows `appAccessSummary(m)` in `text-xs text-muted-foreground`;
- the invite form becomes "Invite an admin" (email only, role `ADMIN`), rendered only when `invitableRoles.includes('ADMIN')`. The pending list stays.

Settings page (after the Task 10 gate):
- fetch `getSampleKey`, `listMembers`, `listInvites` and `getAppAccess(t, ctx.app.id)` in parallel. Any 401 → refresh redirect, as today;
- render `<section id="people" aria-label="People with access">`, `members`, `samples`, then `<section id="danger" aria-label="Danger zone">`;
- `invitableRoles` comes from `ctx.currentOrg.limits.invitableRoles`;
- `SampleKeySection` gets `canManage` set to `true`.

- [ ] **Step 5: Run everything**

Run:
```bash
pnpm --filter @query-analyser/api db:generate && caffeinate -i pnpm --filter @query-analyser/api test && pnpm --filter @query-analyser/api exec tsc --noEmit
caffeinate -i pnpm --filter @query-analyser/web test && pnpm --filter @query-analyser/web exec tsc --noEmit && pnpm --filter @query-analyser/web build
```
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/web/components/settings "apps/web/app/dashboard/[org]/[app]/settings/page.tsx" apps/web/src/settings-page.test.tsx
git commit -m "feat(web): people with access, member apps and deleting an app in settings"
```
