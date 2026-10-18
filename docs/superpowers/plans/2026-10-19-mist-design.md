# Mist Restyle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restyle query-analyser's web app in the approved "Mist" look: a new homepage, plus Mist on the auth, onboarding and dashboard screens.

**Architecture:** Mist is a token change in `apps/web/app/globals.css` (palette, haze on `body`, two glass surfaces, pill radius) plus a handful of small marketing primitives. The homepage is rebuilt from those primitives as server-rendered sections, with Motion only as client leaves. The auth, onboarding and dashboard screens swap class names to the new surfaces; their behaviour and structure don't change.

**Tech Stack:** Next 16 App Router, Tailwind 4 (CSS-variable theme), shadcn/ui, framer-motion 14.0.0, `next/font/google`, Vitest + Testing Library.

**Spec:** `docs/superpowers/specs/2026-10-19-mist-design.md`. Approved mockup: `.superpowers/brainstorm/28625-1792339168/content/homepage-v2.html`. Read both.

## Global Constraints

- Palette: base `#F7F8FC`; haze = layered radial gradients of `#DCE6FF`, `#EADFFB` and `#E3EEFF` over the base; ink text `#1E2235`; text accent periwinkle `#6A72C9` (darken until it passes AA, see below); chart/bar periwinkle `#7C83D6`, **never used for text**; card border `#E3E6F3`.
- Surfaces: `--glass` ≈ 70% white and `--glass-strong` ≈ 90% white, both with backdrop blur, a hairline border and a soft blue-grey shadow. Use `--glass-strong` for dense data (tables, sidebar, queries list). Where `backdrop-filter` is unsupported (`@supports not (backdrop-filter: blur(1px))`), both fall back to solid near-white.
- Contrast is WCAG AA, measured against the base `#F7F8FC` and against `--glass-strong` composited on the base: body and small text ≥ 4.5:1, large text (≥ 24px, or ≥ 18.66px bold) ≥ 3:1. If a spec hex fails, darken it until it passes. The contrast test below is the gate.
- Primary buttons are pills: ink background, white text, `rounded-full`.
- Fonts: Inter for UI, JetBrains Mono for code, and **Instrument Serif** (weight 400, normal + italic, latin subset, `display: 'swap'`) through `next/font/google`. The serif is used only for italic accent words.
- Motion: framer-motion stays the only animation runtime. No WebGL. Every animation honours `prefers-reduced-motion`. Motion components are client leaves inside server sections.
- No new npm packages.
- Every colour and radius is a CSS variable in `app/globals.css`.
- Behaviour, routes and copy of the C1 dashboard, auth and onboarding are unchanged; only styling changes.
- External links open in a new tab with `rel="noopener noreferrer"`. Docs and npm go to `https://www.npmjs.com/package/@vivekumar08/query-analyser`; GitHub goes to `https://github.com/Vivekumar08/query-analyser`.
- Must stay green: `pnpm --filter web test`, `pnpm --filter web exec tsc --noEmit`, `pnpm --filter web build`, and `src/client-bundle.test.ts` (run it after a build so it isn't skipped).
- Commits: conventional, no `Co-Authored-By` or "Generated with" trailers. Never push.
- Component tests (`.test.tsx`) start with `// @vitest-environment jsdom` as their first line and call `afterEach(cleanup)`.

## Review Focus

1. **Text on glass over the brightest haze.** The lightest haze stops are where grey captions get hard to read. Pinned by the Task 1 contrast tests on every text token.
2. **Browsers without `backdrop-filter`** (older Firefox, some Android WebViews). Glass must stay readable. Pinned by the Task 1 CSS test that requires an `@supports not (backdrop-filter…)` fallback for both glass tokens.
3. **Reduced motion.** Nothing on the homepage animates when the user prefers reduced motion. Pinned by the Task 3 test that renders the page with `useReducedMotion` mocked to true and expects no transform or opacity animation props on the motion leaves.
4. **Mobile width (390px).** The hero stacks with no horizontal scroll, and the product preview sits below the copy. Pinned by the Task 6 screenshot check at 390px and 1280px.
5. **The homepage drifting into the auth bundle.** The homepage must import nothing from auth, session or refresh. Pinned by the Task 3 import grep and, after the Task 6 build, by `client-bundle.test.ts`.

---

## File Structure

| Path | Responsibility |
|---|---|
| `apps/web/app/globals.css` | Mist tokens, haze on `body`, `.glass` / `.glass-strong` utilities, fallback |
| `apps/web/app/layout.tsx` | adds Instrument Serif (`--font-serif`) |
| `apps/web/src/contrast.ts` | `contrastRatio`, `compositeOver` (pure, for the token gate) |
| `apps/web/src/mist-tokens.ts` | the hex values of every Mist text/surface token, imported by the contrast test and mirrored in CSS |
| `apps/web/components/marketing/Eyebrow.tsx`, `Accent.tsx`, `GlassCard.tsx`, `PillLink.tsx`, `ProductPreview.tsx`, `ExternalLink.tsx` | homepage primitives |
| `apps/web/app/page.tsx` | homepage sections |
| `apps/web/app/_components/*`, `apps/web/app/{login,signup,verify,forgot-password,reset-password,onboarding}/page.tsx`, `components/onboarding/*` | auth and onboarding restyle |
| `apps/web/components/dashboard/*`, `apps/web/app/dashboard/**` | dashboard restyle |
| `apps/web/components/ui/button.tsx` | the default variant becomes a pill |

---

### Task 1: Mist tokens, glass surfaces, serif font, contrast gate

**Files:**
- Create: `apps/web/src/contrast.ts`, `apps/web/src/mist-tokens.ts`
- Modify: `apps/web/app/globals.css`, `apps/web/app/layout.tsx`
- Test: `apps/web/src/contrast.test.ts`, `apps/web/src/mist-css.test.ts`

**Interfaces:**
- Produces:
  - `contrastRatio(fg: string, bg: string): number` (hex `#RRGGBB`, WCAG 2.x relative luminance)
  - `compositeOver(fg: string, alpha: number, bg: string): string` (hex result)
  - `MIST` const in `mist-tokens.ts`: `{ base, ink, muted, caption, accentText, accentChart, border, glassAlpha: 0.7, glassStrongAlpha: 0.9 }` as hex strings and numbers
  - CSS variables: `--background` (base), `--foreground` (ink), `--muted-foreground` (muted), `--caption`, `--accent-text`, `--primary` (ink, for the pill button), `--chart-1` (accentChart), `--chart-2` (muted lilac/zinc), `--glass`, `--glass-strong`, `--glass-border`, `--glass-shadow`, `--radius-pill`
  - utility classes `.glass` and `.glass-strong`
  - Tailwind font variable `--font-serif`

- [ ] **Step 1: Write the failing tests**
  - `contrast.test.ts`:
    - `contrastRatio('#000000','#FFFFFF')` → `21`, to 2 decimal places.
    - `contrastRatio('#FFFFFF','#FFFFFF')` → `1`.
    - `compositeOver('#FFFFFF', 0.9, '#F7F8FC')` → a hex whose channels are each within 1 of the expected blend.
    - "every Mist text token passes AA on the base and on strong glass": for each of `ink`, `muted`, `caption`, `accentText`, both `contrastRatio(token, MIST.base)` and `contrastRatio(token, compositeOver('#FFFFFF', MIST.glassStrongAlpha, MIST.base))` are ≥ 4.5.
    - "the chart periwinkle is not a text token": `MIST.accentChart` is not one of the text tokens above.
  - `mist-css.test.ts` reads `app/globals.css` as text and asserts:
    - every hex in `MIST` appears in it;
    - `.glass` and `.glass-strong` are defined;
    - an `@supports not (backdrop-filter` block sets a solid background for both;
    - `body` has a `background` containing `radial-gradient`.

- [ ] **Step 2: Run them and confirm they fail**
  Run: `pnpm --filter web test src/contrast.test.ts src/mist-css.test.ts`
  Expected: FAIL (modules and tokens missing).

- [ ] **Step 3: Implement `contrast.ts` and `mist-tokens.ts`; write the tokens into `globals.css`; add Instrument Serif to `layout.tsx`**
  - Start from the spec's hexes. Darken `accentText` and `caption` until the AA test passes, keeping the hue. Expect `accentText` to land near `#5B63B8` and `caption` near `#686E8A`.
  - Keep the existing `--destructive`, `--warning-*` and the green success hue unchanged.
  - Keep the `@theme inline` mappings, and add `--color-caption`, `--color-accent-text` and `--font-serif`.

- [ ] **Step 4: Run tests, typecheck, build**
  Run: `pnpm --filter web test && pnpm --filter web exec tsc --noEmit && pnpm --filter web build`
  Expected: all pass.

- [ ] **Step 5: Commit** with `feat(web): Mist tokens, glass surfaces and serif accent font`.

---

### Task 2: Marketing primitives

**Files:**
- Create: `apps/web/components/marketing/Eyebrow.tsx`, `Accent.tsx`, `GlassCard.tsx`, `PillLink.tsx`, `ExternalLink.tsx`, `ProductPreview.tsx`
- Test: `apps/web/components/marketing/primitives.test.tsx`

**Interfaces:**
- Consumes: Task 1's `.glass` / `.glass-strong` classes and the `--font-serif` / `--accent-text` tokens.
- Produces (all server components; none imports from `@/src/auth`, `session` or `refresh`):
  - `<Eyebrow>{children}</Eyebrow>`: small uppercase tracked text in `accent-text`
  - `<Accent>{children}</Accent>`: renders `<em>` in the serif font, italic, `accent-text`
  - `<GlassCard strong?: boolean className?: string>`
  - `<PillLink href: string variant?: 'ink' | 'ghost'>`: a Next `Link`
  - `<ExternalLink href: string>`: an `<a target="_blank" rel="noopener noreferrer">`
  - `<ProductPreview />`: static glass card with "Time wasted · last 24h", a "● live" chip, rows Order.find 4.2s, User.aggregate 1.1s and Cart.findOne 640ms with bars at 100% / 28% / 16%, an SVG p95 curve, and the line `Order.collection.createIndex({ email: 1, total: -1 })`. Values are illustrative; it fetches nothing.

- [ ] **Step 1: Write the failing tests**
  - `Accent` renders an `em` with the serif class.
  - `ExternalLink` has `target="_blank"` and a `rel` containing both `noopener` and `noreferrer`.
  - `PillLink` renders an anchor with the `href` and a `rounded-full` class.
  - `GlassCard strong` has class `glass-strong`; without `strong` it has `glass`.
  - `ProductPreview` contains the texts `Order.find`, `4.2s`, `Time wasted` and `createIndex`.

- [ ] **Step 2: Run and confirm FAIL**
  Run: `pnpm --filter web test components/marketing/primitives.test.tsx`

- [ ] **Step 3: Implement the six components** with the props above, following the mockup's sizes and spacing.

- [ ] **Step 4: Run tests and typecheck.** Expected: PASS.

- [ ] **Step 5: Commit** with `feat(web): marketing primitives for the Mist homepage`.

---

### Task 3: Homepage

**Files:**
- Modify: `apps/web/app/page.tsx`, `apps/web/app/_components/landing/FadeIn.tsx` (only if needed for reduced motion)
- Test: `apps/web/src/homepage.test.tsx`

**Interfaces:**
- Consumes: Task 2 primitives; `CopyButton` (`@/components/dashboard/CopyButton`); `FadeIn`.
- Produces: the homepage at `/`, with sections in the spec's order and anchors `id="how"` and `id="pricing"`.

- [ ] **Step 1: Write the failing tests** (render `app/page.tsx` in jsdom; mock `next/link` if required)
  - The headline text includes "Your slowest queries," and the word "quietly" inside an `em`.
  - The lead text is exactly "One line in your app. We group every slow call by shape and tell you which index to add first."
  - The eyebrow reads "For MongoDB · mongoose 8".
  - Links:
    - nav "Sign in" → `/login`;
    - every "Get your key" link → `/signup`, and there are 2 of them;
    - "How it works" → `#how`;
    - "Pricing" → `#pricing`;
    - "Docs" and "npm" → the npm URL, and "GitHub" → the GitHub URL, all with `target="_blank"`.
  - Anchors: `#how` exists with three step titles ("Install one line", "We group by shape", "Fix what matters first"), and `#pricing` exists with "Free" and "Team".
  - The privacy section contains `priya@shop.in` and `'range'`, and the heading includes "never values".
  - The footer contains "MIT".
  - Reduced motion: with `framer-motion`'s `useReducedMotion` mocked to return true, rendered motion elements carry no `initial` opacity or transform. Assert that the FadeIn children render visible content without a `style` opacity of 0.
  - Import guard: reading `app/page.tsx` and every file under `components/marketing/` as text, none contains `@/src/auth`, `/session` or `/refresh`.

- [ ] **Step 2: Run and confirm FAIL**
  Run: `pnpm --filter web test src/homepage.test.tsx`

- [ ] **Step 3: Rebuild `app/page.tsx`** to the approved mockup and the spec's section list:
  - nav, two-column hero with `ProductPreview`, How it works, Shapes never values, Pricing (glass cards), closing CTA, footer;
  - copy verbatim from the spec;
  - one accent word per heading, using `<Accent>`;
  - the hero stacks on screens narrower than `md`;
  - `FadeIn` only around below-the-fold sections.

- [ ] **Step 4: Run tests, typecheck, build.** Expected: PASS.

- [ ] **Step 5: Commit** with `feat(web): Mist homepage`.

---

### Task 4: Auth and onboarding screens

**Files:**
- Modify:
  - `apps/web/app/_components/AuthForm.tsx`, `ForgotPasswordForm.tsx`, `VerifyClient.tsx`, `ResetClient.tsx`
  - the pages `app/{login,signup,verify,forgot-password,reset-password,onboarding}/page.tsx`
  - `components/onboarding/{OnboardingFlow,VerifyStep,OrgStep,AppStep,InstallStep}.tsx`
  - `components/ui/button.tsx` (the default variant gets `rounded-full`)
- Test: existing tests, plus `apps/web/src/auth-screens-style.test.tsx`

**Interfaces:**
- Consumes: Task 1 tokens, Task 2 `GlassCard`, `Eyebrow` and `Accent`.
- Produces: each auth page shows its form centred inside `<GlassCard strong>` on the haze, with a small wordmark link to `/` above it. The onboarding page shows its step list and active step on glass.

- [ ] **Step 1: Write the failing test** `auth-screens-style.test.tsx`:
  - rendering `AuthForm` (mode `login`) inside the login page wrapper yields an ancestor with class `glass-strong` and a submit button with `rounded-full`;
  - `/forgot-password` likewise.
  - Mock `next/navigation`.

- [ ] **Step 2: Run and confirm FAIL**

- [ ] **Step 3: Restyle.** Swap slate classes for the token classes (`text-foreground`, `text-muted-foreground`, `text-caption`, `border-border`). Change no behaviour, copy or field names. Keep the InstallStep amber key notice and its wording.

- [ ] **Step 4: Run the full web suite, typecheck and build.**
  Expected: all existing auth and onboarding tests still pass, plus the new one.

- [ ] **Step 5: Commit** with `feat(web): Mist auth and onboarding screens`.

---

### Task 5: Dashboard restyle

**Files:**
- Modify: `components/dashboard/{Sidebar,MobileNav,AppSwitcher,PageHeader,StatCard,QueriesTable,QueryFilters,RangeControl,EmptyState,AdviceCard,HistogramChart,TrendChart}.tsx`, `app/dashboard/**/{layout,page,loading,error,not-found}.tsx`
- Test: existing tests, plus `apps/web/src/dashboard-style.test.tsx`

**Interfaces:**
- Consumes: Task 1 tokens, `.glass-strong`, `--chart-1`, `--chart-2`.
- Produces:
  - the sidebar uses `glass-strong` over the haze;
  - the queries table, stat cards, chart cards and the advice card sit on `glass-strong`;
  - the active nav item uses `accent-text` on a translucent periwinkle tint;
  - share bars and chart series use `--chart-1` (p95) and `--chart-2` (calls);
  - no text uses `--chart-1`.

- [ ] **Step 1: Write the failing test** `dashboard-style.test.tsx`:
  - `Sidebar` renders an `aside` with class `glass-strong`;
  - `StatCard` root has `glass-strong`;
  - `QueriesTable`'s share bar uses `bg-chart-1`;
  - Text-colour guard: reading every file under `components/dashboard/*.tsx` as text, none contains `text-chart-1` or `text-[#7C83D6]`.

- [ ] **Step 2: Run and confirm FAIL**

- [ ] **Step 3: Restyle.** Use class swaps only. No layout or logic changes. `HistogramChart` and `TrendChart` keep reading `var(--color-…)`, and the new token values flow through them.

- [ ] **Step 4: Run the full web suite, typecheck and build.** Expected: PASS.

- [ ] **Step 5: Commit** with `feat(web): Mist dashboard`.

---

### Task 6: Visual check and polish

**Files:**
- Modify: only what the screenshots show is wrong.
- Create: `apps/web/docs/mist-screens/*.png`, the reference screenshots, committed.

- [ ] **Step 1: Build and start.**
  Run: `pnpm --filter web build && PORT=3999 API_ORIGIN=https://example.invalid WEB_ORIGIN=http://localhost:3999 pnpm --filter web start`
  Expected: the server listens on 3999. The homepage, `/login`, `/signup` and `/forgot-password` render without the API.

- [ ] **Step 2: Screenshot** `/`, `/login` and `/signup` at 1280×900 and 390×844 using the Chrome DevTools MCP tools (`new_page`, `resize_page` or `emulate`, `take_screenshot` with `fullPage`). Save the images to `apps/web/docs/mist-screens/`.

- [ ] **Step 3: Compare the homepage against the approved mockup** (`homepage-v2.html`).
  - Fix any of these: horizontal scroll at 390px, overlapping text, the preview overflowing, missing haze or glass, or a section order that differs from the spec.
  - Re-shoot after each fix.

- [ ] **Step 4: Check reduced motion.** Emulate `prefers-reduced-motion: reduce` and reload `/`. Expected: no fade or slide on scroll, and all content visible.

- [ ] **Step 5: Stop the server.** Run `pnpm --filter web test` (including `src/client-bundle.test.ts` after the build) and `pnpm --filter web exec tsc --noEmit`. Expected: all green.

- [ ] **Step 6: Commit** with `chore(web): Mist visual check and fixes` (include the screenshots).
