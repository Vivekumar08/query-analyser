# Dashboard C1 — shell, onboarding, queries and query detail

Date: 2026-10-18
Repo: `query-analyser` (`apps/web`)
Builds on: `2026-10-03-customer-dashboard-design.md` (and its 2026-10-11
amendment) and Plan B (`feat/web-auth-and-landing`: auth, session cookie,
refresh, CSRF guard, `safeNext`).

The dashboard spec's build steps 5–7 are split in two. **C1** (this spec) is
the path a new customer walks on day one: sign up, get a key, see their slow
queries. **C2** (later spec) is overview, alerts and settings.

The current landing page is not touched here. A separate homepage redesign
follows C1 and reuses this spec's design tokens and components.

## Decisions taken in brainstorming

| Question | Decision |
|---|---|
| UI library | **shadcn/ui** (MIT, copied into the repo) + **shadcn charts over Recharts** (MIT). Motion stays the only animation runtime. |
| Look | **Light, minimal.** Dark mode later, as a second token block. |
| Scope split | **C1:** shell, onboarding, queries, query detail. **C2:** overview, alerts, settings. |
| Navigation | **Left sidebar**, collapsing to a sheet on mobile. |
| Time range | **Presets (1h · 24h · 7d · 30d) + custom date range**, kept in the URL. |
| Org / app | **One combined switcher**; URLs `/dashboard/[org]/[app]/…`. |
| Data fetching | **Server Components** read the API with the session token; client components stay small. Rejected: client-side fetching (would need a token-bearing proxy for every read, undoing Plan B's "token never on the client"). Rejected: Tremor (second design language). |

## Visual language

- Background white; sidebar `zinc-50`; text on the zinc scale; **one accent,
  `indigo-600`**, for primary buttons, the active nav item and chart series.
- **Inter** for UI, **JetBrains Mono** for query shapes, keys and code, both via
  `next/font` (self-hosted at build, no runtime font request).
- 8px spacing grid. Cards are `rounded-lg` with a hairline border, not shadows.
- All colours and radii are CSS variables in `app/globals.css` (shadcn's theming
  model). Dark mode later is a `.dark` variable block, not a rewrite.
- Motion, all honouring `prefers-reduced-motion`: page fade-in, stat-card number
  count-up, the onboarding "waiting" pulse and "connected" transition. Nothing
  else animates.

## Shell

`app/dashboard/[org]/[app]/layout.tsx` — a Server Component that loads the
user's orgs and the current app, then renders:

- **Sidebar (240px).**
  - Top: the **Org / App switcher** — a popover listing apps grouped by org,
    the current one checked, ending with **+ New app** (→ onboarding steps 3–4
    for the current org).
  - Nav: **Queries**. Overview, Alerts and Settings are shown greyed with a
    "Soon" badge until C2.
  - Bottom: user menu (email, Log out — Plan B's logout route).
- **Mobile:** the sidebar becomes a shadcn `Sheet` behind a menu button.
- **Page header:** title, breadcrumb `Org / App / Page`, and page actions (the
  time-range control on Queries and detail).

### Routing

- `/dashboard` (replaces Plan B's placeholder): `requireSession`, then
  1. no verified email → `/onboarding`;
  2. no org or no app → `/onboarding`;
  3. otherwise → the last-used `org/app` (cookie `qa_last_app`, non-sensitive,
     `Path=/dashboard`, `SameSite=Lax`, 1 year) if the user still belongs to it,
     else the first app of the first org → `/dashboard/[org]/[app]/queries`.
- `/dashboard/[org]/[app]` redirects to `…/queries`.
- An org slug or app id the user cannot see (API 403/404) renders `not-found.tsx`
  ("Not found, or you don't have access" + link to `/dashboard`) — never an
  error page, and never a hint whether it exists.
- Every page under `/dashboard` and `/onboarding` calls `requireSession`; the
  proxy (Plan B, B14) already sends cookie-less requests through refresh.

## Onboarding — `/onboarding`

One page, a vertical step indicator on the left and the active step on the
right. The server decides the starting step from `/v1/me`, `/v1/orgs` and the
org's apps.

1. **Verify your email** (only if `emailVerifiedAt` is null). Shows the
   address, **Resend email** (`POST /v1/auth/verify/request` via a CSRF-guarded route handler), and **I've verified, continue**. Re-checks
   `/v1/me` when the tab regains focus and advances automatically.
2. **Name your workspace** (skipped if the user has any org). Org name; slug
   auto-derived, editable; `POST /v1/orgs`.
3. **Create your first app.** App name (e.g. `my-service`);
   `POST /v1/orgs/:org/apps`, then immediately `POST /v1/apps/:id/keys`.
4. **Install.**
   - A code block: `npm install @vivekumar08/query-analyser` and the
     `init({ apiKey, app })` snippet with the real key and app name filled in.
     **Copy snippet** and **Copy key** buttons.
   - A persistent amber notice: **"This key is shown once. Copy it now — we
     can't show it again."**
   - A status card polling `GET /v1/apps/:id` (`ingest.lastSeenAt`) every 5s:
     "Waiting for your first batch…" (pulse) → **"Connected ✓"** + **Go to your
     queries →**. Polling pauses while the tab is hidden and stops once
     connected. Poll failures show a quiet "Reconnecting…".
   - Leaving before any copy action → confirm dialog "You haven't copied your
     key."
   - After 3 minutes without data, a **Not seeing data?** panel: `QA_KEY` set,
     mongoose 8, only queries ≥ 100ms are reported. Polling continues.

**Key handling (security contract):**
- Steps 2–4 run through server actions / route handlers with the Plan B CSRF
  guard (B19) and upstream headers (B20). The token never reaches the client.
- The plaintext key is returned to the browser **exactly once**, in the step-3
  response that renders step 4. It is never put in a URL, cookie, local/session
  storage, or a cached RSC payload.
- Reloading step 4 shows "Key already shown — create a new key" (a fresh
  `POST /keys`). Revoking keys is C2.

## Queries — `/dashboard/[org]/[app]/queries`

**Controls (all in the URL):** `range` (`1h|24h|7d|30d|custom`, default `24h`;
`custom` adds `from`/`to` ISO dates), `model` (repeatable), `op` (repeatable),
`sort` (`wasted` default, `count`, `p95`, `maxMs`), `limit` (25, +25 per
**Show more**). The page maps these to `GET /v1/apps/:id/queries`.

**Table** (shadcn `Table`; each row links to detail):

| Column | Content |
|---|---|
| Query | `Model.operation` bold; signature in mono, truncated, full text in a tooltip |
| Calls | `count` |
| Time wasted | `formatMs(totalMs)` + a thin bar of its share of the page total |
| Avg | `formatMs` of `totalMs / count`, converted before dividing |
| p95 | `<Percentile>` |
| Max | `formatMs(maxMs)` |
| Distribution | tiny inline histogram from `hist` |

**Loading:** skeleton rows (`loading.tsx`). **Empty:** no data in range → "No
queries ≥ 100ms in this window. Try 7d, or check your app is sending data"
with a link to the install snippet; filters match nothing → "No queries match
these filters" + **Clear filters**.

## Query detail — `/dashboard/[org]/[app]/queries/[sig]`

Reads `GET /v1/apps/:id/queries/:sig` and `…/:sig/series` with the same range.

- **Header:** back link, `Model.operation`, the full signature in a mono block
  with copy, the range control, first/last seen.
- **Stat cards:** Calls · Time wasted · p95 (`<Percentile>`, also p99) · Max.
- **Charts** (side by side, stacked on mobile):
  - **Latency distribution** — bar chart of `hist` buckets with human labels
    (`100–250ms`, `250–500ms`, …, top bucket `≥ Xms`).
  - **Trend** — calls and p95 over time from `/series`, hourly or daily matching
    the API's grain, with tooltip.
- **Suggested index** (when `advice` exists): the `createIndex` call rendered
  from `advice.suggestion` in mono with **Copy**, the `rationale` text, and
  **Mark as applied** / **Dismiss** → `PATCH /v1/apps/:id/advice/:adviceId`
  via a route handler. The API only accepts `APPLIED`/`DISMISSED` (no way back
  to `OPEN`), so the buttons confirm first and there is **no Undo**; the card
  then shows the status. No advice → "No index suggestion — this query already
  looks indexed or is too rare to judge."
- **Redacted sample** (when `redactedSample` is present), labelled "Values are
  never sent — shapes only."

## The two contracts (unchanged from the dashboard spec)

- **`formatMs`** owns every millisecond display. `totalMs` arrives as a numeric
  string; it is converted explicitly before any arithmetic. Output `340ms`,
  `1.2s`, `2m 4s`.
- **`<Percentile>`** owns every percentile display: `interpolated` → `p95 ≈
  300ms`, `floor` → `p95 ≥ 14,002ms`. The glyph is part of the number.

## Errors

| Situation | Behaviour |
|---|---|
| API unreachable / 5xx on a page read | `error.tsx` card "Couldn't load … — Retry"; shell still renders |
| 401 mid-session | Plan B refresh → login flow, no new code |
| 403/404 org, app or signature | `not-found.tsx` |
| Mutation fails | Sonner toast with a safe message; form keeps its values |
| Double submit | Buttons disabled with a spinner while pending |
| Upstream error bodies | Never shown verbatim; mapped to safe messages |

## Testing

Vitest, as in Plan B. No Playwright in C1 (unchanged from the dashboard spec).

- **Pure helpers, each with a mutation check:** `formatMs`; range ↔ `from`/`to`
  (presets, custom, inverted window rejected); URL filter parse/serialise
  round-trip; last-used org/app resolution; histogram bucket labels.
- **Components:** `<Percentile>` one test per basis (deleting the branch fails a
  test); empty-state selection; the key notice and the leave-without-copy
  dialog; switcher grouping.
- **Server actions / route handlers:** create org, app, key; advice PATCH —
  each rejects without the CSRF guard's conditions, forwards the token
  server-side only, and maps upstream errors to safe messages.
- **Security pins:** the ingest key appears only in the step-3 response (not in
  URL, cookies, or a re-rendered payload); the access token appears in no client
  bundle or serialised payload.
- `tsc --noEmit` and `next build` pass.

## Dependencies

Added through the shadcn CLI (component source copied into
`apps/web/components/ui`) plus `recharts`, `sonner`, `lucide-react` and the
Radix primitives shadcn pulls in. **Every new package is pinned to an exact
version published at least 14 days before install** (the supply-chain rule from
Plan B, B16). Fonts via `next/font/google` (self-hosted at build).

## Delivery

Branch `feat/dashboard-c1`, stacked on `feat/web-auth-and-landing` until Plan B
merges, then rebased onto `main`. Subagent-driven, same review gates as Plan B.

Suggested task order: design tokens + shadcn setup → shell, switcher, routing →
onboarding → queries table → query detail + charts → advice actions → polish.

## Out of scope (C2 or later)

Overview, alerts, settings (key list and revoke, members, invites, roles), dark
mode, the homepage redesign, the admin dashboard, Playwright.
