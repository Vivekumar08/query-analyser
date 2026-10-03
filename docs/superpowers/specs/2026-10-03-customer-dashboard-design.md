# Customer dashboard and home page

Date: 2026-10-03
Repo: `query-analyser` (`apps/web`)
Implements: §8 of `2026-09-20-query-analyser-design.md`
Phase: 5, built after the email phase (`2026-10-03-email-verification-and-password-reset-design.md`)

Phase 4 shipped seven read endpoints and they are verified live. This phase is
the first thing a customer actually sees.

## Scope change from the original delivery order

§10 put the marketing home at phase 7. It moves here, because the public link
has to open something that explains the product — a dashboard behind a login is
unshareable. Phase 5 is therefore: **home page, auth screens, onboarding, and
the five dashboard pages.** The admin dashboard stays at phase 6.

## Where it lives

`apps/web` in the existing monorepo, beside `apps/api`.

The repo is public and the project is open-core — the dashboard being readable
is the point, not a leak. A separate repo only pays off when one side must stay
closed, which does not apply. The monorepo already runs pnpm + turbo, so the web
app joins the same build graph.

**One move comes with it:** the read endpoints' response shapes — the ranked
row, the detail payload, `PercentileResult` — live in `apps/api` today. They
move to `packages/contract`, so the UI and the API agree by compilation rather
than by hand-copied interfaces. That shared type is the main reason the monorepo
is worth anything here.

**The repo needs a LICENSE.** Public with no licence means all rights reserved
by default: nobody may legally use, fork or contribute, which is the opposite of
the stated intent. Open-core's usual shape is a permissive core — Apache-2.0 or
MIT — with paid features under a separate licence directory. This should land
before the dashboard attracts attention.

## Hosting and origin

A second EasyPanel service beside `query-analyser-api`, with **one host routed
by path**: `/v1/*` to the API, everything else to the web app. EasyPanel's
domain config takes a `path`, so this is two domain entries, not a proxy.

Same-origin is the whole reason to do it this way. The refresh cookie is already
scoped to `/v1/auth` and `Secure`; same-origin means it keeps working untouched —
no `SameSite=None`, no CORS allowlist, no preflight. The part of the system
easiest to get subtly wrong simply does not exist.

## Rendering and auth

Server Components call the API with the caller's token forwarded, per §8.

- The access token lives in an **httpOnly session cookie the web app sets
  itself**, read server-side. It never reaches client JavaScript.
- On a 401 from a server fetch, a route handler calls `/v1/auth/refresh`,
  rotates the cookie pair, and retries **once**.
- Client components never hold a token. Mutations — acknowledge an alert,
  apply or dismiss advice — go through Next route handlers that attach it
  server-side.

**Refresh must be serialised.** Two concurrent server renders both hitting a 401
would both try to refresh; the API's family-revocation behaviour would then treat
the second as a replay and log the user out. A single-flight guard around the
refresh call, so concurrent callers await one rotation.

## Pages

**Public:** `/` (home), `/login`, `/signup`, plus the verify and reset-password
screens the email phase's links point at.

**Home page.** The install snippet is the hero — the product's claim is that it
takes one line, so the line is the first thing on the page. Below it: what gets
captured, the privacy statement, a screenshot of the query table, plan
placeholders, a signup CTA.

The home copy must set the expectation that signup requires email verification
before the key appears. Block-until-verified is the chosen posture, and a page
promising one line followed by an unmentioned inbox round trip reads as a bait.

**Onboarding**, built and not stubbed: signup → verify email → create the first
app → **the ingest key is shown exactly once**, inside a ready-to-paste snippet
→ the dashboard polls until the first batch lands, then flips to live.

The API returns the plaintext key at exactly one point and never again. The UI
must say so on the screen that shows it. Someone navigating away and losing it
is a support ticket the interface can prevent.

**Dashboard**, scoped org → app → time range:

| Page | Reads |
|---|---|
| Overview | top five from `/queries`, open `/alerts`, ingest health from `/apps/:id` |
| Queries | `/queries` with `sort`, `model`, `op`, `limit` |
| Signature detail | `/queries/:sig` and `/queries/:sig/series` |
| Alerts | `/alerts`, `PATCH` to acknowledge |
| Settings | apps, ingest keys (create, copy once, revoke), members, invites, roles |

Signature detail shows the latency histogram, the hourly trend, the redacted
sample, and the suggested index as a copyable `createIndex` call with
apply/dismiss.

## Two contracts the UI cannot get wrong

**`totalMs` arrives as a numeric string.** It is a `BigInt` behind a BigInt-safe
serializer. Every display path converts explicitly; nothing does arithmetic on
it before converting. A single `formatMs` helper owns this so it cannot drift
page by page.

**`p95` and `p99` carry `basis`.** When it is `interpolated` the UI renders
`p95 ≈ 300ms`. When it is `floor` — the rank landed in the unbounded top
histogram bucket — it renders `p95 ≥ 14,002ms`.

Not a tooltip. The glyph belongs in the number, because the entire reason the
API returns `basis` is that the service refuses to claim precision it does not
have. A shared `<Percentile>` component owns the rule so no page can render a
bare number by accident.

## Empty states

Every empty state says what to do next, per §8. "No data yet — check the key in
your app" beats an empty table. The alerts page before the first nightly
analysis says so explicitly rather than implying there is nothing wrong — that
is the live deployment's current state, so it is the first thing a new user
sees.

## Testing

- **Pure helpers get unit tests with mutation checks**: `formatMs` and its
  BigInt-string conversion, the grain and window mirroring, the refresh
  single-flight guard.
- **`<Percentile>` gets a test per basis.** `interpolated` must render `≈`;
  `floor` must render `≥`. Deleting the branch must fail a test. This is the UI
  equivalent of a gate, and gates pinned by nothing have been this project's
  dominant failure mode.
- **Auth gets two tests that fail when the guard is removed**: an
  unauthenticated request to a dashboard route redirects to `/login`, and the
  access token appears in no client bundle and no serialised payload. The second
  is the web version of "the invite token must never be logged" — a bug that
  already shipped here once.
- **No Playwright in this phase.** It is the right tool eventually, but a browser
  harness is a second CI surface, and the API's own e2e is already the suite's
  flakiest file at roughly one failure in three. Add it deliberately in phase 6
  rather than let it be why this phase's suite is not trusted.

## Deployment

A Dockerfile for `apps/web` using Next's standalone output, deployed as a second
EasyPanel service with the path-routed domain.

The API's deploy took five rounds and the traps are written down in
`apps/api/README.md`. Two apply directly and should be built in from the start:
`.npmrc` must be copied or the frozen install rejects the lockfile's
`autoInstallPeers`, and **every** workspace `package.json` must be copied or
`--frozen-lockfile` fails validating the lockfile against the workspace.

## Build order

Each step is independently shippable.

1. `apps/web` scaffold, Dockerfile, path-routed EasyPanel service — **deploy a
   blank page and prove the origin split works before building on it**
2. Shared response types moved into `packages/contract`
3. Auth: login, signup, session cookie, refresh-with-retry and its single-flight
   guard, route guards
4. Home page — the public link becomes shareable here
5. Onboarding: verify → create app → key shown once → poll until live
6. Queries table and signature detail — `formatMs` and `<Percentile>` land here
7. Overview, alerts, settings

Step 1 comes first deliberately. The origin routing is the assumption every
later step rests on; it is cheap to disprove now and expensive to discover late.

## Out of scope

- Admin dashboard (phase 6)
- Billing and the paid-feature boundary — open-core is the intent, the split is
  a later scope
- `GET /v1/admin/offenders`, still unimplemented from the original spec
- Playwright and any browser-driven end-to-end suite
