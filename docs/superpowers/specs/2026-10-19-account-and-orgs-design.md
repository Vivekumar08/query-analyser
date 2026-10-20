# Account page, own organisations, and role-correct app creation

Date: 2026-10-19
Repo: `query-analyser` (`apps/api`, `apps/web`). Builds on `main` (team-and-samples merged).

## Why

The user tested the invite flow and found two problems:

1. **Members can create apps in the team's org.** The API allows MEMBER+ (`apps/api/src/apps/routes.ts:17`). Only ADMIN+ can mint the ingest key, though, so a member makes an app that can never receive data. Onboarding makes this worse: it steers an invited member straight into "create an app" inside the inviter's org.
2. **There is no way to work in your own space.** An invitee isn't asked for an org name because they already belong to one. There's also no "create an organisation" anywhere in the dashboard, and no account page: the API has `GET /v1/me` and nothing to edit. Whatever a user tries ends up in the current team's org.

In the user's words: "whatever I'm doing is just creating confusion to current org, need profile edit option for such things."

## Goals

- Anyone can create their own organisation from the dashboard and switch between organisations.
- A personal **Account** page covers name, password, and the user's organisations (switch / leave / create).
- App creation is ADMIN+ in the API and in the UI. Invited MEMBER/VIEWER users land on the team's dashboard, not in app setup.

## Non-goals

Changing email, deleting an account, avatars, organisation rename/delete, transferring ownership, and per-app roles.

## Anti-goals

- Any action taken in one org silently affecting another.
- A member seeing a "New app" button that only fails after they click it.
- Leaving an org that would end up with no owner.
- A password change that leaves other sessions signed in.

## 1. API (`apps/api`)

| Route | Who | Behaviour |
|---|---|---|
| `POST /v1/orgs/:org/apps` | **ADMIN+** (was MEMBER+) | Unchanged otherwise. MEMBER/VIEWER get 403. |
| `PATCH /v1/me` | signed in | Body `{ name }`: trimmed, 1–100 chars. Returns the same shape as `GET /v1/me`. Unknown fields are ignored. |
| `POST /v1/me/password` | signed in, rate-limited 10/min | Body `{ currentPassword, newPassword }`. `newPassword` follows signup's rule (12–200). Wrong current password → 403 `{ error: 'wrong-password' }`. New equal to current → 400. On success: hash and store, revoke **every** refresh token for the user, then issue a fresh session exactly as login does (same response shape, sets the refresh cookie) so this device stays signed in. |
| `DELETE /v1/orgs/:org/membership` | any member (VIEWER+) | The caller leaves the org. Last OWNER → 409 `{ error: 'organization must keep at least one owner' }`, using the same row lock as the member-removal route. 204 on success. |
| `POST /v1/orgs` | unchanged | Already lets any verified user create an org and become OWNER. |

- **Reserved slugs:** org slugs that would collide with static dashboard routes (`account`, `new`) get the random suffix, like a taken slug does. Existing rows aren't migrated; none should exist, but log it in the PR if one does.
- **Tests** for every route: authz, validation, last-owner, refresh-token revocation (an old refresh token fails after a password change, the new session works).

## 2. Web (`apps/web`)

### Organisation switching and creation
- The app switcher (`components/dashboard/AppSwitcher.tsx`) gets:
  - a list of the user's **organisations** (current one marked, each with the user's role) above the apps;
  - a **"New organisation"** item for everyone.
- "New organisation" goes to `/onboarding?new=org`. `resolveOnboardingStart` returns step `'org'` when `new=org`, even if the user already has orgs. The existing org step creates the org (the user is OWNER), then the flow continues to the app and install steps in **that** org, which the user owns.
- "New app" in the switcher is shown only when the user's role in the current org is ADMIN or OWNER.

### New org route: `/dashboard/[org]` (controller's call)
- This route doesn't exist today.
- **When the org has apps:** redirect to the last-used app in that org (the `qa_last_app` cookie, if it belongs to this org), else to the org's first app.
- **When the org has no apps:** render an org home in the bare Mist shell, the same shell as the Account page. No app sidebar, so `getShellContext` and the sidebar are not refactored. It shows:
  - the org name and the user's role;
  - an org switcher list (the user's orgs, each linking to `/dashboard/<slug>`), plus "Account" and "Log out";
  - the empty state. For MEMBER/VIEWER: "No apps yet. Ask an admin to connect one." plus "Create your own organisation" (→ `/onboarding?new=org`). For ADMIN+: "Connect your first app" (→ `/onboarding?org=<slug>`).
- Every org link ("Open" on the Account page, org entries in the switcher) points at `/dashboard/<slug>`.

### Landing rule: `/dashboard` (controller's call; replaces "first org")
- `resolveLanding`, in order:
  1. a valid `qa_last_app` (still accessible);
  2. the first app in any org;
  3. the **first org with no apps**, at `/dashboard/<slug>` (the empty state);
  4. `/onboarding` only when the user is unverified or has **no** orgs.
- This breaks the `/dashboard` ↔ `/onboarding` loop for a member whose orgs have no apps.

### Onboarding role awareness
- `resolveOnboardingStart` receives each org's role. When the target or first org's role is below ADMIN, it never returns `'app'` or `'install'`; it returns `'done'`.

### Invite accept goes to the team (controller's call)
- The API accept response adds the org's `slug` (`{ orgId, slug, role }`; additive).
- The BFF passes it through.
- `AcceptInviteClient` redirects to `/dashboard/<slug>` (falling back to `/dashboard` without a slug).
- Update the invite tests.

### Account page: `/dashboard/account`
- Static route with a simple Mist shell: wordmark / back link ("← Back to dashboard") at the top, glass cards below. No app sidebar.
- **Profile card:**
  - name input with Save;
  - email shown read-only, with its verified badge.
- **Password card:**
  - current password, new password (≥ 12) and confirm;
  - Save → BFF → `POST /v1/me/password`. The BFF stores the new session cookies the same way the login handler does.
  - Copy: "Other devices are signed out within 15 minutes."
  - **15-minute window (controller's call):** access tokens are stateless 15-minute JWTs. Revoking refresh tokens ends other sessions when their access token expires, exactly like the existing password reset. Closing the window instantly needs a per-request check and a schema column; that is a recorded follow-up. The "other sessions signed in" anti-goal means "past their current access token".
- **Your organisations card:**
  - each org: name, your role, and "Open" (to its dashboard);
  - "Leave" behind a confirm dialog. The last-owner 409 shows "You're the only owner. Make someone else an owner first.";
  - after a successful leave, stay on Account and refresh the list. If `qa_last_app` points into the org that was left, the BFF clears that cookie (controller's call);
  - leaving your only org leaves you with none, so `/dashboard` sends you to onboarding's org step;
  - "Create organisation" goes to `/onboarding?new=org`.
- **Entry points:**
  - the user's name/email at the bottom of the sidebar, next to Log out, links to `/dashboard/account`;
  - the switcher has an "Account" item.
- **BFF routes** follow the existing pattern (`rejectCrossSiteAuthPost` → `sessionOr401` → `authedFetch` → `safeUpstreamMessage`, `no-store`, path params validated with `isSafeSegment`):
  - `PATCH /api/me`
  - `POST /api/me/password`
  - `DELETE /api/orgs/[org]/membership`
  - Bodies are forwarded as explicit allowlists.

### Style and tests
- Mist styling and component-test conventions as before.
- Accessibility: labels, live regions for results, focus kept after a row unmounts.
- Tests:
  - switcher org list and role-gated "New app";
  - `resolveOnboardingStart` role cases and `new=org`;
  - account forms: name save, password validation and success, leave with the 409 message;
  - BFF CSRF, allowlists and param validation;
  - the member empty state.

## Constraints

- No new dependencies. No schema migration (everything uses existing columns).
- Commits: conventional, no co-author trailers. Push only when asked.
- Every existing test stays green.

## Left to the builder

- Exact placement and markup inside the switcher popover.
- How the BFF refreshes its own session cookie after a password change. Mirror the login route handler.
- Whether `/dashboard` remembers the last org (not required).
