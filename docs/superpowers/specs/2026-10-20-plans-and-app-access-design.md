# Plans, per-app access, and deleting an app

Date: 2026-10-20
Repo: `query-analyser` (`apps/api`, `apps/web`). Builds on `main` after #12 and #13.

## Why

The free beta should be small and generous:
- one organisation;
- one app;
- one teammate.

Paid plans come later, so limits must be data, not code branches.

Teammates are invited **to an app, not to the whole organisation**. The user wants to give access to one app without exposing the rest, and that has to scale when orgs have many apps. Users also need to delete an app, partly because the one-app limit otherwise traps them.

## Plans (user approved the controller's suggestion)

| Plan (`Organization.plan`) | Orgs you can own | Apps per org | Invite seats | Invitable roles | Daily data kept |
|---|---|---|---|---|---|
| `free` (beta; the existing default) | 1 | 1 | 1 | `MEMBER` | 7 days |
| `pro` | 1 | 3 | 5 | `ADMIN`, `MEMBER`, `VIEWER` | 30 days |
| `team` | 3 | 10 | 20 | `ADMIN`, `MEMBER`, `VIEWER` | 90 days |

- One module, `apps/api/src/plans.ts`, exports `PLAN_LIMITS` and `limitsFor(plan: string)`. An unknown plan string gets `free` limits.
- `pro` and `team` exist as data only. Nothing sells or assigns them yet; ops can set `Organization.plan` by hand.
- **Orgs you can own:** a user may create a new org only while they OWN fewer orgs than the largest `ownedOrgs` limit among the plans of the orgs they already own (`free` when they own none). Being invited into other orgs is never limited.
- **Seats:** see "Role changes…" below: all memberships plus pending unexpired invites (distinct emails), minus one owner. Revoking an invite or removing a member frees a seat.
- **Invitable roles:** an invite with a role outside the plan's list is refused. OWNER is never invitable, by any plan, through this route.
- **Retention:** the daily-rollup pruning (`apps/api/src/analysis/jobs.ts`, `DAILY_RETENTION_DAYS` today) becomes per org plan. Hourly retention stays at 7 days. The dashboard's range presets must not offer ranges longer than the plan keeps; longer ones are shown disabled with "Kept for N days on your plan".
- **Existing data is grandfathered:** nothing is deleted or demoted because an org is already over a limit; the org just can't add more. The one exception is retention, which applies to everyone on the next prune.
- **Refusal shape:** a limit refusal is `403 { error: 'plan-limit', limit: 'orgs' | 'apps' | 'seats' | 'role', max: number }`. The web maps each to plain copy:
  - orgs: "During the beta, each account can create one organisation. More with paid plans."
  - apps: "During the beta, each organisation has one app. Delete it to connect a different one, or upgrade later."
  - seats: "During the beta, you can invite one teammate. More seats with paid plans."
  - role: "During the beta, teammates join as Members."
- **Concurrency:** limit checks must hold under concurrent requests. Take a lock on the org row, or the user row for the orgs limit, inside the creating transaction. Reuse the existing lock helpers where they fit.

## Per-app access

### Model
- New table `AppAccess`:
  - `id`, `appId` (→ App, cascade), `userId` (→ User, cascade), `role` (Role: `MEMBER` | `VIEWER`), `createdAt`;
  - `@@unique([appId, userId])`.
- **Org OWNER and ADMIN** keep access to every app in their org; they never need `AppAccess` rows.
- **Org MEMBER and VIEWER** can see and use only the apps they have an `AppAccess` row for. Their role on that app is the row's role.
- **Migration:**
  - The new table is additive.
  - A data step gives every existing MEMBER/VIEWER membership an `AppAccess` row for every existing app in their org, with the membership's role, so nobody loses access on deploy.
  - Hand-written SQL inside the migration is fine. It must be idempotent and safe to run on an empty DB.
- **`Invite` gains `appId String?`:**
  - required when the invite role is MEMBER or VIEWER;
  - must be null for ADMIN (org-wide);
  - the app must belong to the inviting org.

### API
- **`requireAppRole`:**
  - For a MEMBER/VIEWER org membership, it requires an `AppAccess` row for that app and uses the row's role. No row gives 404 (not 403), so app existence isn't leaked.
  - OWNER/ADMIN are unchanged.
- **App list:** `GET /v1/orgs/:org/apps` returns only accessible apps for MEMBER/VIEWER.
- **Invites:**
  - `POST /v1/orgs/:org/invites` takes `{ email, role, appId? }` with the validation above.
  - The email copy names the app ("…invited you to **<app>** in **<org>**").
  - The ADMIN-only rule to create invites stays as it is.
- **Accept:**
  - Creates the membership if the user isn't in the org yet, with the invite's role. If the user is already a member, it keeps the existing membership.
  - Then adds the `AppAccess` row.
  - Already has access → 409 (existing copy).
  - Accept response: `{ orgId, slug, role, appId? }`.
- **Revoke one app's access:**
  - `DELETE /v1/apps/:id/access/:userId`, ADMIN+.
  - 204, or 404 when there's no such row.
  - The membership stays; the member keeps any other apps and still counts as a seat. To remove them entirely, use the existing org member removal, which must also delete their `AppAccess` rows in that org.
- **List an app's people:**
  - `GET /v1/apps/:id/access`, ADMIN+.
  - Lists users with access: the org OWNER/ADMINs (marked "all apps") plus `AppAccess` holders.
  - Pending invites for this app are included.

### Role changes, legacy invites and accept edge cases (controller's calls after builder check)
- **Seats count everyone except one owner:** `memberships + pending invites (distinct emails) − 1`. Promoting someone to OWNER therefore never frees a seat. This replaces "non-OWNER memberships" above.
- **`PATCH /v1/orgs/:org/members/:id`** works inside the existing `lockOwnersAndTarget` transaction:
  - The new role must be OWNER or one of the plan's invitable roles, else 403 `plan-limit` `role`. On free that leaves Member ↔ Owner only.
  - Promotion to ADMIN or OWNER deletes the member's `AppAccess` rows in that org; they now have org-wide access.
  - Demotion from ADMIN/OWNER to MEMBER/VIEWER grants `AppAccess` to **every current app** in the org with the new role, so they lose nothing silently. Admins can trim access afterwards per app.
  - MEMBER ↔ VIEWER updates all of the member's `AppAccess` rows in that org to the new role.
  - Being made an OWNER doesn't count against the target's "orgs you can own" limit. That limit only gates creating orgs.
- **Legacy invites** (pending at deploy, `appId` null):
  - These are honoured as issued.
  - A legacy MEMBER/VIEWER invite grants `AppAccess` to every app in the org on accept, matching the membership backfill.
  - Legacy OWNER/ADMIN invites accept as before.
  - New OWNER invites can't be created.
- **Accept when the user is already in the org:**
  - **App invite:** add or keep the `AppAccess` row with the invite's role. That role can be higher than the membership role. From now on, for app-scoped members, `Membership.role` only means "not org-wide". The UI shows per-app roles, e.g. "Member · Shop, Admin panel".
  - **Org-wide ADMIN invite** to an existing MEMBER/VIEWER: promote them to ADMIN under the same lock, and delete their `AppAccess` rows.
  - **Already has that access:** 409. The invite is **consumed** (marked accepted), so its seat frees up.

### Delete an app
- `DELETE /v1/apps/:id`, ADMIN+, removes the app.
- Existing cascades remove keys, signatures and samples; the new `AppAccess` and app-scoped invites must cascade too.
- Returns 204.

### Web
- **App Settings page** (`/dashboard/[org]/[app]/settings`) gains a **"People with access"** section, which becomes the main place to invite:
  - the people list, with Remove access;
  - pending invites, with Revoke;
  - an invite form that invites to **this** app. The role select is limited to the plan's invitable roles; on free, Member is the only option and is pre-selected.
  - Seat usage is shown, e.g. "1 of 1 seats used".
- **The existing org-level Members section** stays for org roles (owner/admin management). It gains each member's app list. Its invite form is removed in favour of the per-app one; inviting an ADMIN stays possible there on plans that allow it.
- **Danger zone** on App Settings, ADMIN+: **Delete app**. A dialog requires typing the app's name. After deleting, go to `/dashboard/<org>`, which shows the empty state; an admin can connect a new app from there.
- **Limits in the UI:**
  - When the limit is reached, "New organisation" and "New app" stay visible but disabled, with the limit copy as a tooltip or helper text. The API is the real gate.
  - The landing logic, the switcher and the org home use the accessible-app list, so a member never sees apps they can't open.

## Constraints

- **Migrations:** additive (new table, new nullable column), plus the idempotent data step. Created with `prisma migrate dev --create-only` and committed.
- **No new dependencies.**
- **BFF pattern:** the same as before (CSRF guard, session, allowlists, `isSafeSegment`, fixed messages, `no-store`).
- **Commits:** conventional, no co-author trailers. Push only when asked.

## Non-goals

- Billing.
- Plan purchase or upgrade UI.
- Changing a user's plan from the app.
- Per-app ADMIN.
- Transferring an app between orgs.
- Soft delete / undo for app deletion.

## Anti-goals

- A member seeing, or getting a 403 instead of a 404 for, an app they weren't given.
- A limit that can be bypassed by sending two requests at once.
- Existing members losing access on deploy.
- A deleted app leaving orphaned access rows or invites.

## Left to the builder

- Exact UI layout of the People section.
- Whether app-scoped and org-scoped invites share one list component.
- The tooltip mechanism for disabled buttons.
