# Mist — homepage redesign and dashboard restyle

Date: 2026-10-19
Repo: `query-analyser` (`apps/web`)
Builds on: Dashboard C1 (`feat/dashboard-c1`) and its design system (shadcn/ui, CSS-variable tokens).
Mockup: `.superpowers/brainstorm/28625-1792339168/content/homepage-v2.html` (approved).

## Why

A client looked at the deployed site and called it ugly. The homepage is plain text on white, half the
page is empty, and nothing shows what the product looks or feels like. The goal is a **subtle, soothing**
look that makes a developer trust the package and want to install it, the way polished packages feel.

## What was decided

- **Look: "Mist".** A soft periwinkle/lilac haze background (layered radial gradients over `#F7F8FC`),
  frosted-glass cards (white at ~70% with backdrop blur, hairline `#E3E6F3` border, soft blue-grey
  shadow), ink text `#1E2235`, accent periwinkle `#6A72C9` (text/eyebrows) and `#7C83D6` (charts/bars).
- **Voice: "Paper's" words.** Warmer, human copy instead of the old engineering tone. Headline
  "Your slowest queries, *quietly* found." with one italic serif accent word per heading
  (Instrument Serif). Body in Inter, code in JetBrains Mono (both already in the app).
- **Pill-shaped primary buttons** (ink `#1E2235` background, white text).
- **Dashboard follows the same Mist look** so the product matches the homepage (controller's reading of
  "looks good, go ahead" — the user approved the homepage mockup and the question included the dashboard).

## Homepage (`/`), top to bottom — as in the approved mockup

1. **Nav:** wordmark `◐ query·analyser`; links "How it works" (anchor `#how`), "Docs" (npm package page),
   "Pricing" (anchor `#pricing`), "Sign in" (`/login`).
2. **Hero, two columns** (stacks on mobile):
   - Left: eyebrow "For MongoDB · mongoose 8"; headline "Your slowest queries, *quietly* found.";
     lead "One line in your app. We group every slow call by shape and tell you which index to add first.";
     the install snippet in a glass box with a Copy button; pill "Get your key →" (`/signup`) and
     "Free while in beta" beside it.
   - Right: a glass **product preview** (static, illustrative): "Time wasted · last 24h" with a "● live"
     chip, three rows (Order.find 4.2s, User.aggregate 1.1s, Cart.findOne 640ms) with proportional bars,
     a soft p95 curve, and a suggested `createIndex` line.
3. **How it works** (`#how`): eyebrow, heading "Three steps, *no dashboards to wire up.*", three glass
   cards: Install one line · We group by shape · Fix what matters first (copy as in the mockup).
4. **Shapes, *never values*:** left text ("Key names, operator classes, durations and counts. No documents,
   no IDs, no customer data. Ever."); right a glass code card: "you run" `Order.find({ email: 'priya@shop.in',
   total: { $gte: 500 } })` vs "we receive" `{ model: 'Order', op: 'find', filter: { email: 'eq', total: 'range' } }`.
5. **Pricing** (`#pricing`): keep the existing two plans (Free: one app, seven days of history; Team: coming
   soon) restyled as glass cards. *(Not in the mockup; kept so the nav link has a target.)*
6. **Closing CTA:** glass panel "Find your first slow query *today.*", "Sign up, verify your email, paste one
   line. Data arrives in about ten seconds.", pill "Get your key →".
7. **Footer:** `◐ query·analyser · MIT` and links GitHub · npm · Docs.

Keep the spec's existing honesty notes: signup requires email verification before the key appears (the
"verify your email" wording above covers it).

## Dashboard restyle (all C1 screens)

- Same tokens: the haze as the app background, sidebar as a translucent glass panel, cards/tables/charts on
  glass surfaces, accent and chart colours switched from indigo-600 to the periwinkle pair, pill primary
  buttons, Instrument Serif available for page titles' accent word only where it reads naturally (the builder
  may decide it's only used on onboarding and empty states).
- Layout, components and behaviour from C1 are **unchanged** — this is a visual pass, not a rework.
- Text contrast must stay at WCAG AA on glass over the haze (body text ≥ 4.5:1, large text ≥ 3:1).

## Auth and onboarding screens

`/login`, `/signup`, `/verify`, `/forgot-password`, `/reset-password` and `/onboarding` also get the Mist look
(haze background, glass card for the form, pill buttons), so there is no plain-white seam between the homepage's
"Get your key →" and the dashboard. The haze therefore lives on `body` (app-wide), not in individual layouts.
Behaviour of these pages is unchanged. *(Controller's call — follows from the anti-goal of mismatched screens.)*

## Tokens and colour roles

- Two glass surfaces: `--glass` (~70% white, for hero/marketing cards) and `--glass-strong` (~90% white, for
  dense data: tables, the sidebar, the queries list), each with a hairline border and soft shadow. Over-haze text
  contrast is verified against the strong surface for data screens. *(Controller's call.)*
- Accent roles: `#6A72C9` is the only periwinkle allowed for **text** (eyebrows, links, serif accent words).
  `#7C83D6` is for bars, chart strokes and fills only — never text (≈3.3:1 on the haze).
- Semantic colours stay distinct from the accent: destructive (red), warning (the existing amber notice) and
  success (the green "Connected ✓") keep their current hues, softened only if contrast still passes.
- Charts that show two series (Trend: calls and p95) use the periwinkle for p95 and a muted zinc/lilac
  (`--chart-2`) for calls, so they stay distinguishable. No new multi-series charts are added.

## Links and facts on the public page

- **Docs** → `https://www.npmjs.com/package/@vivekumar08/query-analyser` (the README is the docs for now).
- **GitHub** → `https://github.com/Vivekumar08/query-analyser` (public, confirmed). **npm** → the npm page above.
- **MIT** is accurate: the repo's `LICENSE` is MIT.
- External links open in a new tab with `rel="noopener noreferrer"`.

## Constraints

- Landing performance budget (`2026-10-03-customer-dashboard-design.md`, amendment "Landing performance budget"):
  no WebGL, Motion is the only animation runtime, animations respect `prefers-reduced-motion`, Motion components
  stay client *leaves* of server sections. There is no numeric budget; the existing `client-bundle.test.ts` pins
  stay green. Instrument Serif is added through `next/font/google` with only weight 400 (normal + italic), latin
  subset, `display: swap`, so it adds one small font file.
- `backdrop-filter` must degrade to a solid near-white surface where unsupported.
- No new npm packages unless unavoidable; any new package exact-pinned, published ≥ 14 days before install.
- All colours/radii remain CSS variables in `app/globals.css` (dark mode later is a second token block).
- Existing tests keep passing; the client-bundle pins stay green.

## Non-goals

Dark mode; new dashboard features or pages; a docs site; real pricing; replacing shadcn/ui.

## Anti-goals (a failure even if it works)

Loud gradients or neon; animation-heavy hero; anything that slows the public page noticeably; low-contrast
grey-on-haze text that's hard to read; a dashboard that no longer matches the homepage.

## Left to the builder

Exact gradient stops and blur amounts, shadow values, responsive breakpoints, how the product preview
scales on mobile, subtle hover states, whether the preview gets a gentle fade-in, and which dashboard
headings get a serif accent (if any).
