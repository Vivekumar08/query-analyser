# Dashboard C1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give a signed-up customer a light, minimal dashboard: guided onboarding to their first ingest key, then a queries table and per-query detail, inside an org/app-scoped shell.

**Architecture:** Next 16 App Router in `apps/web`. Pages are Server Components that read the API through Plan B's `authedFetch` with the session token; URL search params carry range and filters. Mutations (create org/app/key, resend verification, advice status) and the onboarding poll go through Next route handlers guarded by Plan B's `rejectCrossSiteAuthPost`, so the token never reaches the browser. UI is shadcn/ui (copied source) + shadcn charts over Recharts, themed by CSS variables.

**Tech Stack:** Next 16, React 19, Tailwind 4, shadcn/ui, Recharts, Sonner, lucide-react, framer-motion 14.0.0, Vitest (+ jsdom and Testing Library for component tests), pnpm workspace.

**Spec:** `docs/superpowers/specs/2026-10-18-dashboard-c1-design.md` (builds on `docs/superpowers/specs/2026-10-03-customer-dashboard-design.md`).

## Global Constraints

- Every new npm package is pinned to an **exact** version published **at least 14 days before install** (check with `npm view <pkg> time --json`); no `^`/`~`. framer-motion stays `14.0.0`.
- The access token never reaches client JavaScript: no client component receives it, no route handler returns it.
- The ingest key plaintext is returned to the browser exactly once (the create-app route handler's JSON response) and is never put in a URL, cookie, `localStorage`/`sessionStorage`, or a server-rendered payload.
- Every state-changing route handler starts with `rejectCrossSiteAuthPost(request)` (Plan B, B19).
- Every redirect from a route handler uses `relativeRedirect` (Plan B, B18); redirect targets that come from user input go through `safeNext`.
- `totalMs` is a numeric string: convert with `parseNumericString` (`@query-analyser/contract`) before any arithmetic; all millisecond display goes through `formatMs`.
- All percentile display goes through `<Percentile>`: `interpolated` → `≈`, `floor` → `≥`, glyph inside the number.
- Look: white background, sidebar `zinc-50`, one accent `indigo-600`, Inter (UI) + JetBrains Mono (code) via `next/font/google`; every colour/radius is a CSS variable in `app/globals.css`.
- Motion only for: page fade-in, stat count-up, onboarding waiting pulse / connected transition; all honour `prefers-reduced-motion`.
- Commits: conventional, no `Co-Authored-By` / "Generated with" trailers. Never push.
- Verify per task: `pnpm --filter web test`, `pnpm --filter web exec tsc --noEmit`; tasks that touch pages also `pnpm --filter web build`.

## Review Focus

1. **A user who belongs to an org with zero apps, or whose last-used app was deleted / access revoked.** Expected: `/dashboard` sends them to onboarding or their first available app, never a 404 loop. Test: Task 4 `resolveLanding` cases "stale cookie" and "org without apps".
2. **Reloading or navigating back to onboarding step 4 after the key was shown.** Expected: "Key already shown — create a new key"; the key is not re-displayed. Test: Task 6 `onboarding-state.test.ts` "key step without key in memory".
3. **Custom range with `from` after `to`, malformed dates, or a span the API rejects.** Expected: falls back to 24h with no 500. Test: Task 2 `range.test.ts` "inverted" and "garbage".
4. **`totalMs` larger than 2^53 or `"0"` with `count` 0.** Expected: formats without NaN/Infinity; avg shows `—`. Test: Task 2 `format.test.ts` "huge" and "zero count".
5. **Upstream 4xx/5xx bodies on mutations (e.g. 409 app exists).** Expected: a safe, specific message ("An app with that name already exists"), never the raw body. Test: Task 6 `onboarding-routes.test.ts` "409 maps to message".

---

## File Structure

| Path | Responsibility |
|---|---|
| `apps/web/components.json` | shadcn CLI config |
| `apps/web/lib/utils.ts` | `cn()` class merger (shadcn) |
| `apps/web/components/ui/*` | shadcn component source (button, card, input, label, table, popover, command, sheet, dialog, alert-dialog, skeleton, tooltip, badge, sonner, toggle-group, calendar, chart, separator, dropdown-menu) |
| `apps/web/app/globals.css` | design tokens (CSS variables), Tailwind 4 theme mapping |
| `apps/web/app/layout.tsx` | fonts, `<Toaster/>` |
| `apps/web/src/format.ts` | `formatMs`, `toMs`, `avgMsDisplay` |
| `apps/web/src/range.ts` | range presets ↔ `{from,to}` |
| `apps/web/src/filters.ts` | queries URL params parse/serialise |
| `apps/web/src/hist.ts` | histogram bucket labels |
| `apps/web/src/dashboard-types.ts` | wire types the dashboard reads |
| `apps/web/src/dashboard-api.ts` | typed server-side readers over `authedFetch` |
| `apps/web/src/landing.ts` | `resolveLanding` (where `/dashboard` sends a user) |
| `apps/web/src/route-session.ts` | `sessionOr401` for route handlers |
| `apps/web/src/upstream-errors.ts` | upstream status → safe message |
| `apps/web/src/onboarding-state.ts` | onboarding step resolution |
| `apps/web/components/dashboard/*` | Percentile, Sidebar, AppSwitcher, PageHeader, RangeControl, QueryFilters, QueriesTable, StatCard, HistogramChart, TrendChart, AdviceCard, EmptyState, RememberApp |
| `apps/web/components/onboarding/*` | OnboardingFlow and step components |
| `apps/web/app/dashboard/page.tsx` | landing resolver (replaces Plan B placeholder) |
| `apps/web/app/dashboard/[org]/[app]/layout.tsx` | shell |
| `apps/web/app/dashboard/[org]/[app]/page.tsx` | → queries |
| `apps/web/app/dashboard/[org]/[app]/queries/page.tsx` (+ `loading.tsx`, `error.tsx`) | queries table |
| `apps/web/app/dashboard/[org]/[app]/queries/[sig]/page.tsx` (+ `loading.tsx`) | detail |
| `apps/web/app/dashboard/[org]/[app]/not-found.tsx`, `error.tsx` | shell-level fallbacks |
| `apps/web/app/onboarding/page.tsx` | onboarding |
| `apps/web/app/api/onboarding/org/route.ts` | POST create org |
| `apps/web/app/api/onboarding/app/route.ts` | POST create app + key |
| `apps/web/app/api/auth/verify-request/route.ts` | POST resend verification |
| `apps/web/app/api/apps/[id]/status/route.ts` | GET ingest status (poll) |
| `apps/web/app/api/apps/[id]/advice/[adviceId]/route.ts` | PATCH advice status |
| `apps/web/vitest.config.ts` | include `.tsx` tests; jsdom per file |

---

### Task 1: Design system — shadcn, tokens, fonts, test harness

**Files:**
- Create: `apps/web/components.json`, `apps/web/lib/utils.ts`, `apps/web/components/ui/*` (via CLI), `apps/web/src/utils.test.ts`
- Modify: `apps/web/app/globals.css`, `apps/web/app/layout.tsx`, `apps/web/package.json`, `apps/web/vitest.config.ts`, `pnpm-lock.yaml`

**Interfaces:**
- Produces: `cn(...inputs: ClassValue[]): string` from `@/lib/utils`; shadcn components importable as `@/components/ui/<name>`; CSS variables `--background --foreground --muted --muted-foreground --border --primary --primary-foreground --accent --sidebar --radius --chart-1 --chart-2`; font CSS variables `--font-sans --font-mono`; `<Toaster />` mounted in root layout. Vitest runs `src/**/*.test.ts`, `src/**/*.test.tsx`, `components/**/*.test.tsx`.

- [ ] **Step 1: Pick dependency versions (≥14 days old)**

For each of `clsx tailwind-merge class-variance-authority lucide-react recharts sonner react-day-picker date-fns @testing-library/react @testing-library/dom jsdom`, run `npm view <pkg> time --json` and choose the newest version whose publish date is at least 14 days before today and that matches the shadcn CLI's expectations (React 19). Record the chosen versions in the commit message body.

- [ ] **Step 2: Initialise shadcn and add components**

Run from `apps/web` (answer prompts: style New York, base colour zinc, CSS variables yes):

```bash
pnpm dlx shadcn@<version ≥14 days old> init
pnpm dlx shadcn@<same> add button card input label table popover command sheet dialog alert-dialog skeleton tooltip badge sonner toggle-group calendar chart separator dropdown-menu
```

Then rewrite every dependency the CLI added in `apps/web/package.json` to the exact versions from Step 1 (no `^`), and run `pnpm install` from the repo root. Confirm `components.json` has `"aliases": { "components": "@/components", "utils": "@/lib/utils" }` (the repo's `@/*` alias maps to `apps/web/*`).

- [ ] **Step 3: Write the design tokens**

Replace `apps/web/app/globals.css` with (keep anything the CLI generated for `@theme inline` that maps these variables, but these values win):

```css
@import "tailwindcss";

@custom-variant dark (&:is(.dark *));

:root {
  --radius: 0.5rem;
  --background: oklch(1 0 0);                 /* white */
  --foreground: oklch(0.21 0.006 285.885);    /* zinc-900 */
  --muted: oklch(0.967 0.001 286.375);        /* zinc-100 */
  --muted-foreground: oklch(0.552 0.016 285.938); /* zinc-500 */
  --border: oklch(0.92 0.004 286.32);         /* zinc-200 */
  --input: oklch(0.92 0.004 286.32);
  --ring: oklch(0.511 0.262 276.966);         /* indigo-600 */
  --primary: oklch(0.511 0.262 276.966);      /* indigo-600 */
  --primary-foreground: oklch(0.985 0 0);
  --accent: oklch(0.962 0.018 272.314);       /* indigo-50 */
  --accent-foreground: oklch(0.398 0.195 277.366); /* indigo-800 */
  --card: oklch(1 0 0);
  --card-foreground: oklch(0.21 0.006 285.885);
  --popover: oklch(1 0 0);
  --popover-foreground: oklch(0.21 0.006 285.885);
  --secondary: oklch(0.967 0.001 286.375);
  --secondary-foreground: oklch(0.21 0.006 285.885);
  --destructive: oklch(0.577 0.245 27.325);
  --sidebar: oklch(0.985 0 0);                /* zinc-50 */
  --warning-bg: oklch(0.987 0.022 95.277);    /* amber-50 */
  --warning-fg: oklch(0.473 0.137 46.201);    /* amber-800 */
  --chart-1: oklch(0.511 0.262 276.966);      /* indigo-600 */
  --chart-2: oklch(0.705 0.015 286.067);      /* zinc-400 */
}

@theme inline {
  --font-sans: var(--font-inter);
  --font-mono: var(--font-jetbrains-mono);
  --radius-lg: var(--radius);
  --radius-md: calc(var(--radius) - 2px);
  --radius-sm: calc(var(--radius) - 4px);
  --color-background: var(--background);
  --color-foreground: var(--foreground);
  --color-muted: var(--muted);
  --color-muted-foreground: var(--muted-foreground);
  --color-border: var(--border);
  --color-input: var(--input);
  --color-ring: var(--ring);
  --color-primary: var(--primary);
  --color-primary-foreground: var(--primary-foreground);
  --color-accent: var(--accent);
  --color-accent-foreground: var(--accent-foreground);
  --color-card: var(--card);
  --color-card-foreground: var(--card-foreground);
  --color-popover: var(--popover);
  --color-popover-foreground: var(--popover-foreground);
  --color-secondary: var(--secondary);
  --color-secondary-foreground: var(--secondary-foreground);
  --color-destructive: var(--destructive);
  --color-sidebar: var(--sidebar);
  --color-warning-bg: var(--warning-bg);
  --color-warning-fg: var(--warning-fg);
  --color-chart-1: var(--chart-1);
  --color-chart-2: var(--chart-2);
}

@layer base {
  * { @apply border-border; }
  body { @apply bg-background text-foreground font-sans antialiased; }
}
```

- [ ] **Step 4: Fonts and toaster in the root layout**

```tsx
// apps/web/app/layout.tsx
import type { Metadata } from 'next';
import { Inter, JetBrains_Mono } from 'next/font/google';
import { Toaster } from '@/components/ui/sonner';
import './globals.css';

const inter = Inter({ subsets: ['latin'], variable: '--font-inter', display: 'swap' });
const mono = JetBrains_Mono({ subsets: ['latin'], variable: '--font-jetbrains-mono', display: 'swap' });

export const metadata: Metadata = {
  title: 'Query Analyser',
  description: 'Find the queries costing you the most time.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${inter.variable} ${mono.variable}`}>
      <body className="min-h-screen">
        {children}
        <Toaster position="bottom-right" richColors />
      </body>
    </html>
  );
}
```

- [ ] **Step 5: Extend Vitest to component tests**

```ts
// apps/web/vitest.config.ts
import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Mirrors tsconfig.json's `@/*` -> `./*` path alias so tests can import
  // route handlers (which use `@/src/...` imports) directly.
  resolve: { alias: { '@': path.resolve(__dirname, '.') } },
  test: {
    // node by default; component tests opt into jsdom with a
    // `// @vitest-environment jsdom` first line.
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'components/**/*.test.tsx'],
  },
});
```

Add `"jsx": "preserve"` is already in tsconfig; Vitest uses esbuild's automatic JSX — if a `.test.tsx` fails with "React is not defined", add `esbuild: { jsx: 'automatic' }` to the config.

- [ ] **Step 6: Write the smoke test**

```ts
// apps/web/src/utils.test.ts
import { describe, it, expect } from 'vitest';
import { cn } from '@/lib/utils';

describe('cn', () => {
  it('merges conflicting tailwind classes, last wins', () => {
    expect(cn('px-2 text-sm', 'px-4')).toBe('text-sm px-4');
  });
  it('drops falsy values', () => {
    expect(cn('a', false && 'b', undefined, 'c')).toBe('a c');
  });
});
```

- [ ] **Step 7: Run and verify**

Run: `pnpm --filter web test && pnpm --filter web exec tsc --noEmit && pnpm --filter web build`
Expected: all pass (105+2 tests), build succeeds.

- [ ] **Step 8: Commit**

```bash
git add apps/web pnpm-lock.yaml
git commit -m "feat(web): design system — shadcn/ui, light tokens, Inter + JetBrains Mono"
```

---

### Task 2: Pure display helpers — formatMs, range, filters, histogram labels

**Files:**
- Create: `apps/web/src/format.ts`, `apps/web/src/range.ts`, `apps/web/src/filters.ts`, `apps/web/src/hist.ts`
- Test: `apps/web/src/format.test.ts`, `apps/web/src/range.test.ts`, `apps/web/src/filters.test.ts`, `apps/web/src/hist.test.ts`

**Interfaces:**
- Consumes: `parseNumericString`, `HIST_BOUNDS`, `HIST_SIZE` from `@query-analyser/contract` / `@query-analyser/contract/runtime`.
- Produces:
  - `toMs(v: number | string): number` (throws on non-numeric string)
  - `formatMs(v: number | string): string` → `"0ms" | "340ms" | "1.2s" | "2m 4s" | "1h 3m"`
  - `formatAvg(totalMs: string, count: number): string` (`"—"` when count 0)
  - `formatCount(n: number): string` (`12,345`)
  - `type RangePreset = '1h' | '24h' | '7d' | '30d'`; `type RangeState = { kind: 'preset'; preset: RangePreset } | { kind: 'custom'; from: string; to: string }`
  - `parseRange(params: URLSearchParams | Record<string, string | string[] | undefined>): RangeState` (default `{kind:'preset',preset:'24h'}`)
  - `rangeToWindow(r: RangeState, now?: Date): { from: string; to: string }` (ISO strings)
  - `rangeToParams(r: RangeState): Record<string, string>`
  - `type SortKey = 'wasted' | 'count' | 'p95' | 'maxMs'`; `interface QueryFilters { range: RangeState; models: string[]; ops: string[]; sort: SortKey; limit: number }`
  - `parseFilters(params): QueryFilters`; `filtersToSearch(f: QueryFilters): string` (no leading `?`, defaults omitted); `filtersToApiQuery(f, now?): string`
  - `histLabels(): string[]` → `['100–250ms','250–500ms','500ms–1s','1–2.5s','2.5–5s','5–10s','≥ 10s', ...]` matching `HIST_SIZE`

- [ ] **Step 1: Write the failing tests**

```ts
// apps/web/src/format.test.ts
import { describe, it, expect } from 'vitest';
import { formatMs, toMs, formatAvg, formatCount } from './format';

describe('toMs', () => {
  it('converts a numeric string', () => expect(toMs('1500')).toBe(1500));
  it('passes numbers through', () => expect(toMs(42)).toBe(42));
  it('rejects garbage', () => expect(() => toMs('12ms')).toThrow());
});

describe('formatMs', () => {
  it('zero', () => expect(formatMs(0)).toBe('0ms'));
  it('sub-second', () => expect(formatMs(340)).toBe('340ms'));
  it('rounds sub-second to whole ms', () => expect(formatMs(340.6)).toBe('341ms'));
  it('seconds with one decimal', () => expect(formatMs(1234)).toBe('1.2s'));
  it('minutes and seconds', () => expect(formatMs(124_000)).toBe('2m 4s'));
  it('hours and minutes', () => expect(formatMs(3_780_000)).toBe('1h 3m'));
  it('accepts the API numeric string', () => expect(formatMs('1500')).toBe('1.5s'));
  it('huge values above 2^53 still format', () =>
    expect(formatMs('90071992547409930')).toMatch(/^\d[\d,]*h \d+m$/));
});

describe('formatAvg', () => {
  it('converts before dividing', () => expect(formatAvg('3000', 4)).toBe('750ms'));
  it('zero count shows an em dash', () => expect(formatAvg('0', 0)).toBe('—'));
});

describe('formatCount', () => {
  it('groups thousands', () => expect(formatCount(12345)).toBe('12,345'));
});
```

```ts
// apps/web/src/range.test.ts
import { describe, it, expect } from 'vitest';
import { parseRange, rangeToWindow, rangeToParams } from './range';

const NOW = new Date('2026-10-18T12:00:00.000Z');

describe('parseRange', () => {
  it('defaults to 24h', () => expect(parseRange({})).toEqual({ kind: 'preset', preset: '24h' }));
  it('reads a preset', () => expect(parseRange({ range: '7d' })).toEqual({ kind: 'preset', preset: '7d' }));
  it('unknown preset falls back to 24h', () => expect(parseRange({ range: '5y' })).toEqual({ kind: 'preset', preset: '24h' }));
  it('reads a custom range', () =>
    expect(parseRange({ range: 'custom', from: '2026-10-01', to: '2026-10-05' })).toEqual({
      kind: 'custom', from: '2026-10-01T00:00:00.000Z', to: '2026-10-05T23:59:59.999Z',
    }));
  it('inverted custom range falls back to 24h', () =>
    expect(parseRange({ range: 'custom', from: '2026-10-05', to: '2026-10-01' })).toEqual({ kind: 'preset', preset: '24h' }));
  it('garbage custom dates fall back to 24h', () =>
    expect(parseRange({ range: 'custom', from: 'yesterday', to: 'x' })).toEqual({ kind: 'preset', preset: '24h' }));
  it('accepts URLSearchParams', () => expect(parseRange(new URLSearchParams('range=1h'))).toEqual({ kind: 'preset', preset: '1h' }));
});

describe('rangeToWindow', () => {
  it('1h', () => expect(rangeToWindow({ kind: 'preset', preset: '1h' }, NOW)).toEqual({
    from: '2026-10-18T11:00:00.000Z', to: '2026-10-18T12:00:00.000Z' }));
  it('30d', () => expect(rangeToWindow({ kind: 'preset', preset: '30d' }, NOW).from).toBe('2026-09-18T12:00:00.000Z'));
  it('custom passes through', () => expect(rangeToWindow({ kind: 'custom', from: 'a', to: 'b' }, NOW)).toEqual({ from: 'a', to: 'b' }));
});

describe('rangeToParams', () => {
  it('omits the default', () => expect(rangeToParams({ kind: 'preset', preset: '24h' })).toEqual({}));
  it('custom keeps dates as YYYY-MM-DD', () =>
    expect(rangeToParams({ kind: 'custom', from: '2026-10-01T00:00:00.000Z', to: '2026-10-05T23:59:59.999Z' }))
      .toEqual({ range: 'custom', from: '2026-10-01', to: '2026-10-05' }));
});
```

```ts
// apps/web/src/filters.test.ts
import { describe, it, expect } from 'vitest';
import { parseFilters, filtersToSearch, filtersToApiQuery } from './filters';

const NOW = new Date('2026-10-18T12:00:00.000Z');

describe('parseFilters', () => {
  it('defaults', () => expect(parseFilters({})).toEqual({
    range: { kind: 'preset', preset: '24h' }, models: [], ops: [], sort: 'wasted', limit: 25 }));
  it('repeatable model and op', () => {
    const f = parseFilters(new URLSearchParams('model=Order&model=User&op=find'));
    expect(f.models).toEqual(['Order', 'User']);
    expect(f.ops).toEqual(['find']);
  });
  it('unknown sort falls back', () => expect(parseFilters({ sort: 'drop' }).sort).toBe('wasted'));
  it('limit is a positive multiple of 25, capped at 500', () => {
    expect(parseFilters({ limit: '50' }).limit).toBe(50);
    expect(parseFilters({ limit: '-3' }).limit).toBe(25);
    expect(parseFilters({ limit: '9999' }).limit).toBe(500);
  });
});

describe('filtersToSearch', () => {
  it('round-trips and omits defaults', () => {
    const s = 'range=7d&model=Order&op=find&sort=p95&limit=50';
    expect(filtersToSearch(parseFilters(new URLSearchParams(s)))).toBe(s);
    expect(filtersToSearch(parseFilters({}))).toBe('');
  });
});

describe('filtersToApiQuery', () => {
  it('maps to the API params', () => {
    const q = new URLSearchParams(filtersToApiQuery(parseFilters(new URLSearchParams('range=1h&model=Order&sort=count')), NOW));
    expect(q.get('from')).toBe('2026-10-18T11:00:00.000Z');
    expect(q.get('to')).toBe('2026-10-18T12:00:00.000Z');
    expect(q.getAll('model')).toEqual(['Order']);
    expect(q.get('sort')).toBe('count');
    expect(q.get('limit')).toBe('25');
  });
});
```

```ts
// apps/web/src/hist.test.ts
import { describe, it, expect } from 'vitest';
import { HIST_SIZE } from '@query-analyser/contract/runtime';
import { histLabels } from './hist';

describe('histLabels', () => {
  it('one label per bucket', () => expect(histLabels()).toHaveLength(HIST_SIZE));
  it('labels match the shared bounds', () =>
    expect(histLabels()).toEqual(['< 100ms', '100–250ms', '250–500ms', '500ms–1s', '1–2.5s', '2.5–5s', '5–10s', '≥ 10s']));
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter web test src/format.test.ts src/range.test.ts src/filters.test.ts src/hist.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement**

```ts
// apps/web/src/format.ts
import { parseNumericString } from '@query-analyser/contract';

/** Milliseconds from the API: a number, or a NumericString (BigInt behind it). */
export function toMs(v: number | string): number {
  if (typeof v === 'number') return v;
  return parseNumericString(v);
}

/**
 * The only way the dashboard renders a duration. `totalMs` is a numeric
 * string; it is converted here, before any arithmetic, so no page can add or
 * divide a string by accident.
 */
export function formatMs(v: number | string): string {
  const ms = toMs(v);
  if (!Number.isFinite(ms) || ms <= 0) return '0ms';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1).replace(/\.0$/, '')}s`;
  const totalSeconds = Math.floor(ms / 1000);
  if (totalSeconds < 3600) return `${Math.floor(totalSeconds / 60)}m ${totalSeconds % 60}s`;
  const hours = Math.floor(totalSeconds / 3600);
  return `${hours.toLocaleString('en-US')}h ${Math.floor((totalSeconds % 3600) / 60)}m`;
}

export function formatAvg(totalMs: string, count: number): string {
  if (count <= 0) return '—';
  return formatMs(toMs(totalMs) / count);
}

export function formatCount(n: number): string {
  return n.toLocaleString('en-US');
}
```

If `parseNumericString` throws for values above 2^53 (check its implementation in `packages/contract/src/wire.ts`), `formatMs` must still produce a value: in that case use `Number(v)` after validating `/^\d+$/`, and keep the "rejects garbage" test passing.

```ts
// apps/web/src/range.ts
export type RangePreset = '1h' | '24h' | '7d' | '30d';
export type RangeState =
  | { kind: 'preset'; preset: RangePreset }
  | { kind: 'custom'; from: string; to: string };

type Params = URLSearchParams | Record<string, string | string[] | undefined>;

const PRESET_MS: Record<RangePreset, number> = {
  '1h': 3_600_000,
  '24h': 86_400_000,
  '7d': 7 * 86_400_000,
  '30d': 30 * 86_400_000,
};
const DEFAULT: RangeState = { kind: 'preset', preset: '24h' };
const DAY = /^\d{4}-\d{2}-\d{2}$/;

export function getParam(p: Params, key: string): string | undefined {
  if (p instanceof URLSearchParams) return p.get(key) ?? undefined;
  const v = p[key];
  return Array.isArray(v) ? v[0] : v;
}

export function getParams(p: Params, key: string): string[] {
  if (p instanceof URLSearchParams) return p.getAll(key);
  const v = p[key];
  return v === undefined ? [] : Array.isArray(v) ? v : [v];
}

export function parseRange(p: Params): RangeState {
  const range = getParam(p, 'range');
  if (range && range in PRESET_MS) return { kind: 'preset', preset: range as RangePreset };
  if (range === 'custom') {
    const from = getParam(p, 'from');
    const to = getParam(p, 'to');
    if (!from || !to || !DAY.test(from) || !DAY.test(to)) return DEFAULT;
    const f = new Date(`${from}T00:00:00.000Z`);
    const t = new Date(`${to}T23:59:59.999Z`);
    if (Number.isNaN(f.getTime()) || Number.isNaN(t.getTime()) || f > t) return DEFAULT;
    return { kind: 'custom', from: f.toISOString(), to: t.toISOString() };
  }
  return DEFAULT;
}

export function rangeToWindow(r: RangeState, now: Date = new Date()): { from: string; to: string } {
  if (r.kind === 'custom') return { from: r.from, to: r.to };
  return { from: new Date(now.getTime() - PRESET_MS[r.preset]).toISOString(), to: now.toISOString() };
}

export function rangeToParams(r: RangeState): Record<string, string> {
  if (r.kind === 'custom') return { range: 'custom', from: r.from.slice(0, 10), to: r.to.slice(0, 10) };
  return r.preset === '24h' ? {} : { range: r.preset };
}
```

```ts
// apps/web/src/filters.ts
import { getParam, getParams, parseRange, rangeToParams, rangeToWindow, type RangeState } from './range';

export type SortKey = 'wasted' | 'count' | 'p95' | 'maxMs';
const SORTS: SortKey[] = ['wasted', 'count', 'p95', 'maxMs'];
export const PAGE_SIZE = 25;
const MAX_LIMIT = 500;

export interface QueryFilters {
  range: RangeState;
  models: string[];
  ops: string[];
  sort: SortKey;
  limit: number;
}

type Params = URLSearchParams | Record<string, string | string[] | undefined>;

export function parseFilters(p: Params): QueryFilters {
  const sort = getParam(p, 'sort');
  const rawLimit = Number(getParam(p, 'limit'));
  const limit = Number.isInteger(rawLimit) && rawLimit > 0
    ? Math.min(MAX_LIMIT, Math.ceil(rawLimit / PAGE_SIZE) * PAGE_SIZE)
    : PAGE_SIZE;
  return {
    range: parseRange(p),
    models: getParams(p, 'model').filter(Boolean),
    ops: getParams(p, 'op').filter(Boolean),
    sort: SORTS.includes(sort as SortKey) ? (sort as SortKey) : 'wasted',
    limit,
  };
}

export function filtersToSearch(f: QueryFilters): string {
  const s = new URLSearchParams(rangeToParams(f.range));
  for (const m of f.models) s.append('model', m);
  for (const o of f.ops) s.append('op', o);
  if (f.sort !== 'wasted') s.set('sort', f.sort);
  if (f.limit !== PAGE_SIZE) s.set('limit', String(f.limit));
  return s.toString();
}

export function filtersToApiQuery(f: QueryFilters, now: Date = new Date()): string {
  const { from, to } = rangeToWindow(f.range, now);
  const s = new URLSearchParams({ from, to, sort: f.sort, limit: String(f.limit) });
  for (const m of f.models) s.append('model', m);
  for (const o of f.ops) s.append('op', o);
  return s.toString();
}
```

```ts
// apps/web/src/hist.ts
import { HIST_BOUNDS } from '@query-analyser/contract/runtime';

const short = (ms: number) => (ms < 1000 ? `${ms}ms` : `${ms / 1000}s`);

/** Human labels for the shared histogram buckets, lowest first. */
export function histLabels(): string[] {
  const labels = [`< ${short(HIST_BOUNDS[0])}`];
  for (let i = 1; i < HIST_BOUNDS.length; i++) {
    const lo = HIST_BOUNDS[i - 1]!;
    const hi = HIST_BOUNDS[i]!;
    labels.push(lo < 1000 && hi >= 1000 ? `${short(lo)}–${short(hi)}` : lo >= 1000 ? `${lo / 1000}–${short(hi)}` : `${lo}–${short(hi)}`);
  }
  labels.push(`≥ ${short(HIST_BOUNDS[HIST_BOUNDS.length - 1]!)}`);
  return labels;
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `pnpm --filter web test src/format.test.ts src/range.test.ts src/filters.test.ts src/hist.test.ts`
Expected: PASS.

- [ ] **Step 5: Mutation checks**

Make each change, confirm a named test fails, revert: (a) in `formatAvg` divide before `toMs`; (b) in `parseRange` drop the `f > t` check; (c) in `filtersToSearch` always set `sort`; (d) in `histLabels` drop the final `≥` label. Record results in the report.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/format.ts apps/web/src/range.ts apps/web/src/filters.ts apps/web/src/hist.ts apps/web/src/*.test.ts
git commit -m "feat(web): formatMs, range, filter and histogram helpers"
```

---

### Task 3: `<Percentile>` component

**Files:**
- Create: `apps/web/components/dashboard/Percentile.tsx`
- Test: `apps/web/components/dashboard/Percentile.test.tsx`

**Interfaces:**
- Consumes: `formatMs` (Task 2); `PercentileResult` from `@query-analyser/contract`.
- Produces: `<Percentile label="p95" value={PercentileResult | null} />` → `<span>` text `p95 ≈ 300ms` / `p95 ≥ 14s` / `p95 —` when null. Prop `showLabel?: boolean` (default true; table cells pass false → `≈ 300ms`).

- [ ] **Step 1: Write the failing test**

```tsx
// @vitest-environment jsdom
// apps/web/components/dashboard/Percentile.test.tsx
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { Percentile } from './Percentile';

describe('Percentile', () => {
  it('interpolated renders ≈', () => {
    const { container } = render(<Percentile label="p95" value={{ value: 300, basis: 'interpolated' }} />);
    expect(container.textContent).toBe('p95 ≈ 300ms');
  });
  it('floor renders ≥', () => {
    const { container } = render(<Percentile label="p95" value={{ value: 14002, basis: 'floor' }} />);
    expect(container.textContent).toBe('p95 ≥ 14s');
  });
  it('null renders a dash', () => {
    const { container } = render(<Percentile label="p99" value={null} />);
    expect(container.textContent).toBe('p99 —');
  });
  it('can hide the label', () => {
    const { container } = render(<Percentile label="p95" showLabel={false} value={{ value: 300, basis: 'interpolated' }} />);
    expect(container.textContent).toBe('≈ 300ms');
  });
  it('floor carries an explanatory title', () => {
    const { getByTitle } = render(<Percentile label="p95" value={{ value: 14002, basis: 'floor' }} />);
    expect(getByTitle(/at least/i)).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter web test components/dashboard/Percentile.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```tsx
// apps/web/components/dashboard/Percentile.tsx
import type { PercentileResult } from '@query-analyser/contract';
import { formatMs } from '@/src/format';

/**
 * The only way a percentile is rendered. `basis` is in the glyph, not a
 * tooltip: `floor` means the rank landed in the unbounded top bucket, so the
 * service refuses to claim more than a lower bound.
 */
export function Percentile({
  label,
  value,
  showLabel = true,
}: {
  label: string;
  value: PercentileResult | null;
  showLabel?: boolean;
}) {
  const prefix = showLabel ? `${label} ` : '';
  if (!value) return <span className="tabular-nums">{prefix}—</span>;
  const floor = value.basis === 'floor';
  return (
    <span
      className="tabular-nums"
      title={floor ? `At least ${formatMs(value.value)} — the slowest calls exceed the top histogram bucket` : undefined}
    >
      {prefix}
      {floor ? '≥' : '≈'} {formatMs(value.value)}
    </span>
  );
}
```

- [ ] **Step 4: Run to verify it passes; mutation check**

Run: `pnpm --filter web test components/dashboard/Percentile.test.tsx` → PASS. Then replace the ternary with `'≈'` and confirm "floor renders ≥" fails; revert.

- [ ] **Step 5: Commit**

```bash
git add apps/web/components/dashboard/Percentile.tsx apps/web/components/dashboard/Percentile.test.tsx
git commit -m "feat(web): Percentile renders its basis in the number"
```

---

### Task 4: Dashboard data layer and landing resolution

**Files:**
- Create: `apps/web/src/dashboard-types.ts`, `apps/web/src/dashboard-api.ts`, `apps/web/src/landing.ts`
- Modify: `apps/web/app/dashboard/page.tsx` (replace Plan B placeholder)
- Test: `apps/web/src/landing.test.ts`, `apps/web/src/dashboard-api.test.ts`

**Interfaces:**
- Consumes: `authedFetch`, `ApiResult` (`@/src/api`); `requireSession` (`@/src/auth`); `RankedQueryRow`, `PercentileResult`, `Serialized` (`@query-analyser/contract`).
- Produces (`dashboard-types.ts`):
  ```ts
  export type Role = 'OWNER' | 'ADMIN' | 'MEMBER' | 'VIEWER';
  export interface OrgSummary { id: string; name: string; slug: string; plan: string; createdAt: string; role: Role }
  export interface AppSummary { id: string; name: string; env: string; createdAt: string }
  export interface AppDetail extends AppSummary { orgId: string; ingest: { lastSeenAt: string | null; keyCount: number } }
  export interface SuggestionField { field: string; dir: 1 | -1 }
  export interface Advice { id: string; suggestion: SuggestionField[]; rationale: string; status: 'OPEN' | 'APPLIED' | 'DISMISSED'; updatedAt: string }
  export interface QueryDetail {
    hash: string; signature: string; model: string; operation: string;
    firstSeen: string; lastSeen: string; count: number; totalMs: string; maxMs: number;
    avgMs: number | null; p95: PercentileResult | null; p99: PercentileResult | null;
    hist: number[]; redactedSample: unknown | null; advice: Advice | null;
  }
  export interface SeriesPoint { at: string; count: number; totalMs: string; maxMs: number; avgMs: number | null; p95: PercentileResult | null }
  export interface SeriesResponse { grain: 'hourly' | 'daily'; from: string; to: string; points: SeriesPoint[] }
  export type QueryRow = Serialized<import('@query-analyser/contract').RankedQueryRow> & { p95?: PercentileResult | null; avgMs?: number | null };
  ```
  (Confirm each field against `apps/api/src/{orgs,apps,analysis}/routes.ts`; adjust names/optionality to match the API exactly and note any change in the report.)
- Produces (`dashboard-api.ts`): `listOrgs(token)`, `listApps(token, orgSlug)`, `getApp(token, appId)`, `listQueries(token, appId, apiQuery: string)`, `getQuery(token, appId, hash, window: {from,to})`, `getSeries(token, appId, hash, window)`, `getMe(token)` — each `Promise<ApiResult<T>>`. Org path segment is the org **slug** (`/v1/orgs/:org` resolves slug — verify in `apps/api/src/orgs/rbac.ts`; if it takes id, use id in URLs and say so).
- Produces (`landing.ts`): 
  ```ts
  export const LAST_APP_COOKIE = 'qa_last_app';
  export type Landing = { kind: 'onboarding' } | { kind: 'app'; org: string; app: string };
  export function resolveLanding(input: {
    emailVerified: boolean;
    orgs: { slug: string; apps: { id: string }[] }[];
    lastApp: string | undefined; // cookie value "orgSlug/appId"
  }): Landing;
  export function appPath(org: string, app: string): string; // `/dashboard/${org}/${app}/queries`, segments encoded
  export function readLastApp(raw: string | undefined): string | undefined; // decodeURIComponent, undefined on error (added in Task 5)
  ```

- [ ] **Step 1: Write the failing tests**

```ts
// apps/web/src/landing.test.ts
import { describe, it, expect } from 'vitest';
import { resolveLanding, appPath } from './landing';

const orgs = [
  { slug: 'acme', apps: [{ id: 'a1' }, { id: 'a2' }] },
  { slug: 'beta', apps: [{ id: 'b1' }] },
];

describe('resolveLanding', () => {
  it('unverified email goes to onboarding', () =>
    expect(resolveLanding({ emailVerified: false, orgs, lastApp: 'acme/a1' })).toEqual({ kind: 'onboarding' }));
  it('no orgs goes to onboarding', () =>
    expect(resolveLanding({ emailVerified: true, orgs: [], lastApp: undefined })).toEqual({ kind: 'onboarding' }));
  it('org without apps goes to onboarding', () =>
    expect(resolveLanding({ emailVerified: true, orgs: [{ slug: 'acme', apps: [] }], lastApp: undefined })).toEqual({ kind: 'onboarding' }));
  it('valid cookie wins', () =>
    expect(resolveLanding({ emailVerified: true, orgs, lastApp: 'beta/b1' })).toEqual({ kind: 'app', org: 'beta', app: 'b1' }));
  it('stale cookie (app gone) falls back to first app', () =>
    expect(resolveLanding({ emailVerified: true, orgs, lastApp: 'acme/zz' })).toEqual({ kind: 'app', org: 'acme', app: 'a1' }));
  it('cookie for an org no longer a member of falls back', () =>
    expect(resolveLanding({ emailVerified: true, orgs, lastApp: 'gone/b1' })).toEqual({ kind: 'app', org: 'acme', app: 'a1' }));
  it('first org with apps is chosen when the first org is empty', () =>
    expect(resolveLanding({ emailVerified: true, orgs: [{ slug: 'empty', apps: [] }, ...orgs], lastApp: undefined }))
      .toEqual({ kind: 'app', org: 'acme', app: 'a1' }));
});

describe('appPath', () => {
  it('builds the queries path with encoded segments', () =>
    expect(appPath('ac me', 'a/1')).toBe('/dashboard/ac%20me/a%2F1/queries'));
});
```

```ts
// apps/web/src/dashboard-api.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./api', () => ({ authedFetch: vi.fn(async () => ({ ok: true, data: [] })) }));
import { authedFetch } from './api';
import { listApps, listQueries, getQuery, getSeries } from './dashboard-api';

describe('dashboard-api', () => {
  beforeEach(() => vi.mocked(authedFetch).mockClear());
  it('encodes path segments', async () => {
    await listApps('t', 'ac/me');
    expect(vi.mocked(authedFetch).mock.calls[0]![0]).toBe('/v1/orgs/ac%2Fme/apps');
    expect(vi.mocked(authedFetch).mock.calls[0]![1]).toBe('t');
  });
  it('passes the API query through', async () => {
    await listQueries('t', 'a1', 'from=x&to=y&sort=count&limit=25');
    expect(vi.mocked(authedFetch).mock.calls[0]![0]).toBe('/v1/apps/a1/queries?from=x&to=y&sort=count&limit=25');
  });
  it('detail and series carry the window', async () => {
    await getQuery('t', 'a1', 'h#1', { from: 'f', to: 'g' });
    await getSeries('t', 'a1', 'h#1', { from: 'f', to: 'g' });
    expect(vi.mocked(authedFetch).mock.calls[0]![0]).toBe('/v1/apps/a1/queries/h%231?from=f&to=g');
    expect(vi.mocked(authedFetch).mock.calls[1]![0]).toBe('/v1/apps/a1/queries/h%231/series?from=f&to=g');
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter web test src/landing.test.ts src/dashboard-api.test.ts` → FAIL (modules missing).

- [ ] **Step 3: Implement**

Write `dashboard-types.ts` exactly as in Interfaces (after checking the API). Then:

```ts
// apps/web/src/dashboard-api.ts
import { authedFetch, type ApiResult } from './api';
import type { AppDetail, AppSummary, OrgSummary, QueryDetail, QueryRow, SeriesResponse } from './dashboard-types';
import type { Session } from './auth';

const e = encodeURIComponent;
const windowQuery = (w: { from: string; to: string }) => new URLSearchParams(w).toString();

export const getMe = (t: string): Promise<ApiResult<Session['user']>> => authedFetch('/v1/me', t);
export const listOrgs = (t: string): Promise<ApiResult<OrgSummary[]>> => authedFetch('/v1/orgs', t);
export const listApps = (t: string, org: string): Promise<ApiResult<AppSummary[]>> => authedFetch(`/v1/orgs/${e(org)}/apps`, t);
export const getApp = (t: string, app: string): Promise<ApiResult<AppDetail>> => authedFetch(`/v1/apps/${e(app)}`, t);
export const listQueries = (t: string, app: string, apiQuery: string): Promise<ApiResult<QueryRow[]>> =>
  authedFetch(`/v1/apps/${e(app)}/queries?${apiQuery}`, t);
export const getQuery = (t: string, app: string, hash: string, w: { from: string; to: string }): Promise<ApiResult<QueryDetail>> =>
  authedFetch(`/v1/apps/${e(app)}/queries/${e(hash)}?${windowQuery(w)}`, t);
export const getSeries = (t: string, app: string, hash: string, w: { from: string; to: string }): Promise<ApiResult<SeriesResponse>> =>
  authedFetch(`/v1/apps/${e(app)}/queries/${e(hash)}/series?${windowQuery(w)}`, t);
```

```ts
// apps/web/src/landing.ts
export const LAST_APP_COOKIE = 'qa_last_app';
export type Landing = { kind: 'onboarding' } | { kind: 'app'; org: string; app: string };

export function resolveLanding(input: {
  emailVerified: boolean;
  orgs: { slug: string; apps: { id: string }[] }[];
  lastApp: string | undefined;
}): Landing {
  if (!input.emailVerified) return { kind: 'onboarding' };
  if (input.lastApp) {
    const [org, app] = input.lastApp.split('/');
    const match = input.orgs.find((o) => o.slug === org);
    if (match && match.apps.some((a) => a.id === app)) return { kind: 'app', org: org!, app: app! };
  }
  for (const o of input.orgs) {
    const first = o.apps[0];
    if (first) return { kind: 'app', org: o.slug, app: first.id };
  }
  return { kind: 'onboarding' };
}

export function appPath(org: string, app: string): string {
  return `/dashboard/${encodeURIComponent(org)}/${encodeURIComponent(app)}/queries`;
}
```

```tsx
// apps/web/app/dashboard/page.tsx
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { requireSession } from '@/src/auth';
import { listApps, listOrgs } from '@/src/dashboard-api';
import { LAST_APP_COOKIE, appPath, resolveLanding } from '@/src/landing';

/** Where a signed-in visitor belongs: their last app, their first app, or onboarding. */
export default async function DashboardIndex() {
  const session = await requireSession('/dashboard');
  const orgsRes = await listOrgs(session.accessToken);
  const orgs = orgsRes.ok ? orgsRes.data : [];
  const withApps = await Promise.all(
    orgs.map(async (o) => {
      const apps = await listApps(session.accessToken, o.slug);
      return { slug: o.slug, apps: apps.ok ? apps.data : [] };
    }),
  );
  const landing = resolveLanding({
    emailVerified: Boolean(session.user.emailVerifiedAt),
    orgs: withApps,
    lastApp: (await cookies()).get(LAST_APP_COOKIE)?.value,
  });
  redirect(landing.kind === 'onboarding' ? '/onboarding' : appPath(landing.org, landing.app));
}
```

If `listOrgs` fails with a non-401 error, render the shared error card instead of redirecting to onboarding (an outage must not look like "you have no workspace"): `if (!orgsRes.ok) throw new Error('orgs unavailable')` so `app/dashboard/error.tsx` (Task 5) handles it.

- [ ] **Step 4: Run to verify they pass; mutation checks**

Run: `pnpm --filter web test src/landing.test.ts src/dashboard-api.test.ts` → PASS. Mutations: drop the `match.apps.some` check (→ "stale cookie" fails); drop `encodeURIComponent` on the hash (→ detail test fails). Revert.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/dashboard-types.ts apps/web/src/dashboard-api.ts apps/web/src/landing.ts apps/web/src/landing.test.ts apps/web/src/dashboard-api.test.ts apps/web/app/dashboard/page.tsx
git commit -m "feat(web): dashboard readers and where /dashboard lands a user"
```

---

### Task 5: The shell — sidebar, switcher, header, fallbacks

**Files:**
- Create: `apps/web/components/dashboard/Sidebar.tsx`, `AppSwitcher.tsx`, `PageHeader.tsx`, `RememberApp.tsx`, `MobileNav.tsx`, `switcher.ts` (pure grouping), `apps/web/app/dashboard/[org]/[app]/layout.tsx`, `page.tsx`, `not-found.tsx`, `error.tsx`, `apps/web/app/dashboard/error.tsx`
- Test: `apps/web/components/dashboard/switcher.test.ts` → place at `apps/web/src/switcher.test.ts` importing `@/components/dashboard/switcher`; `apps/web/components/dashboard/Sidebar.test.tsx`

**Interfaces:**
- Consumes: `listOrgs`, `listApps`, `getApp` (Task 4); `requireSession`; `LAST_APP_COOKIE`, `appPath`; `LogoutButton` (`app/_components/LogoutButton.tsx`, Plan B).
- Produces:
  - `groupForSwitcher(orgs: {slug,name}[], appsByOrg: Record<string, AppSummary[]>, current: {org,app}) → { org: {slug,name}; apps: { id; name; env; href; current: boolean }[] }[]`
  - `<PageHeader title crumbs={[{label, href?}]} actions?>` — used by Tasks 7–8.
  - Layout passes nothing to children; pages re-read params.
  - `<RememberApp org app />` client component writes `qa_last_app=<org>/<app>; Path=/dashboard; Max-Age=31536000; SameSite=Lax` (non-sensitive, not HttpOnly).

- [ ] **Step 1: Write the failing tests**

```ts
// apps/web/src/switcher.test.ts
import { describe, it, expect } from 'vitest';
import { groupForSwitcher } from '@/components/dashboard/switcher';

describe('groupForSwitcher', () => {
  const orgs = [{ slug: 'acme', name: 'Acme' }, { slug: 'beta', name: 'Beta' }];
  const apps = {
    acme: [{ id: 'a1', name: 'api', env: 'prod', createdAt: '' }],
    beta: [{ id: 'b1', name: 'web', env: 'prod', createdAt: '' }],
  };
  it('groups apps under orgs, marks the current one, builds hrefs', () => {
    const g = groupForSwitcher(orgs, apps, { org: 'beta', app: 'b1' });
    expect(g.map((x) => x.org.slug)).toEqual(['acme', 'beta']);
    expect(g[1]!.apps[0]).toMatchObject({ id: 'b1', current: true, href: '/dashboard/beta/b1/queries' });
    expect(g[0]!.apps[0]!.current).toBe(false);
  });
  it('keeps an org with no apps (so + New app can target it)', () => {
    expect(groupForSwitcher(orgs, { acme: [] }, { org: 'acme', app: 'x' })[0]!.apps).toEqual([]);
  });
});
```

```tsx
// @vitest-environment jsdom
// apps/web/components/dashboard/Sidebar.test.tsx
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SidebarNav } from './Sidebar';

describe('SidebarNav', () => {
  it('Queries is a link; C2 pages are disabled with a Soon badge', () => {
    render(<SidebarNav base="/dashboard/acme/a1" active="queries" />);
    expect(screen.getByRole('link', { name: /queries/i }).getAttribute('href')).toBe('/dashboard/acme/a1/queries');
    for (const name of ['Overview', 'Alerts', 'Settings']) {
      expect(screen.queryByRole('link', { name: new RegExp(name, 'i') })).toBeNull();
      expect(screen.getByText(name).closest('[aria-disabled="true"]')).toBeTruthy();
    }
    expect(screen.getAllByText('Soon')).toHaveLength(3);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter web test src/switcher.test.ts components/dashboard/Sidebar.test.tsx` → FAIL.

- [ ] **Step 3: Implement**

```ts
// apps/web/components/dashboard/switcher.ts
import type { AppSummary } from '@/src/dashboard-types';
import { appPath } from '@/src/landing';

export function groupForSwitcher(
  orgs: { slug: string; name: string }[],
  appsByOrg: Record<string, AppSummary[]>,
  current: { org: string; app: string },
) {
  return orgs.map((org) => ({
    org,
    apps: (appsByOrg[org.slug] ?? []).map((a) => ({
      id: a.id,
      name: a.name,
      env: a.env,
      href: appPath(org.slug, a.id),
      current: org.slug === current.org && a.id === current.app,
    })),
  }));
}
```

```tsx
// apps/web/components/dashboard/Sidebar.tsx
import Link from 'next/link';
import { BarChart3, Bell, LayoutDashboard, Settings } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

const SOON = [
  { name: 'Overview', icon: LayoutDashboard },
  { name: 'Alerts', icon: Bell },
  { name: 'Settings', icon: Settings },
];

export function SidebarNav({ base, active }: { base: string; active: 'queries' }) {
  return (
    <nav className="flex flex-col gap-0.5 px-2 text-sm">
      <Link
        href={`${base}/queries`}
        className={cn(
          'flex items-center gap-2 rounded-md px-2 py-1.5 font-medium',
          active === 'queries' ? 'bg-accent text-accent-foreground' : 'text-foreground hover:bg-muted',
        )}
      >
        <BarChart3 className="size-4" aria-hidden /> Queries
      </Link>
      {SOON.map(({ name, icon: Icon }) => (
        <div key={name} aria-disabled="true" className="flex items-center gap-2 rounded-md px-2 py-1.5 text-muted-foreground">
          <Icon className="size-4" aria-hidden /> <span>{name}</span>
          <Badge variant="secondary" className="ml-auto text-[10px]">Soon</Badge>
        </div>
      ))}
    </nav>
  );
}

export function Sidebar({
  switcher,
  nav,
  footer,
}: {
  switcher: React.ReactNode;
  nav: React.ReactNode;
  footer: React.ReactNode;
}) {
  return (
    <aside className="hidden w-60 shrink-0 flex-col border-r bg-sidebar md:flex">
      <div className="p-3">{switcher}</div>
      <div className="flex-1 py-2">{nav}</div>
      <div className="border-t p-3">{footer}</div>
    </aside>
  );
}
```

```tsx
// apps/web/components/dashboard/AppSwitcher.tsx
'use client';
import Link from 'next/link';
import { Check, ChevronsUpDown, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Command, CommandGroup, CommandItem, CommandList, CommandSeparator } from '@/components/ui/command';
import type { groupForSwitcher } from './switcher';

export function AppSwitcher({
  groups,
  currentLabel,
  newAppHref,
}: {
  groups: ReturnType<typeof groupForSwitcher>;
  currentLabel: { org: string; app: string };
  newAppHref: string;
}) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" className="h-auto w-full justify-between bg-background px-2 py-1.5">
          <span className="flex min-w-0 flex-col items-start text-left">
            <span className="truncate text-xs text-muted-foreground">{currentLabel.org}</span>
            <span className="truncate text-sm font-medium">{currentLabel.app}</span>
          </span>
          <ChevronsUpDown className="size-4 text-muted-foreground" aria-hidden />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-64 p-0" align="start">
        <Command>
          <CommandList>
            {groups.map((g) => (
              <CommandGroup key={g.org.slug} heading={g.org.name}>
                {g.apps.map((a) => (
                  <CommandItem key={a.id} asChild>
                    <Link href={a.href}>
                      <span className="truncate">{a.name}</span>
                      <span className="ml-1 text-xs text-muted-foreground">{a.env}</span>
                      {a.current && <Check className="ml-auto size-4" aria-label="current" />}
                    </Link>
                  </CommandItem>
                ))}
              </CommandGroup>
            ))}
            <CommandSeparator />
            <CommandGroup>
              <CommandItem asChild>
                <Link href={newAppHref}><Plus className="size-4" aria-hidden /> New app</Link>
              </CommandItem>
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
```

If the installed `CommandItem` does not support `asChild`, wrap a `Link` inside it and navigate with `onSelect={() => router.push(href)}` instead; keyboard selection must navigate.

```tsx
// apps/web/components/dashboard/RememberApp.tsx
'use client';
import { useEffect } from 'react';
import { LAST_APP_COOKIE } from '@/src/landing';

/** Remembers the last app opened. Not sensitive: an org slug and app id. */
export function RememberApp({ org, app }: { org: string; app: string }) {
  useEffect(() => {
    document.cookie = `${LAST_APP_COOKIE}=${encodeURIComponent(`${org}/${app}`)}; Path=/dashboard; Max-Age=31536000; SameSite=Lax`;
  }, [org, app]);
  return null;
}
```

Because the cookie value is URI-encoded, decode it in `app/dashboard/page.tsx` before `resolveLanding` (`decodeURIComponent`, wrapped in try/catch → `undefined`). Add a `landing.test.ts` case: encoded value `acme%2Fa1` resolves to `acme/a1` after decoding (put the decoding in a `readLastApp(raw: string | undefined): string | undefined` export of `landing.ts`).

```tsx
// apps/web/components/dashboard/PageHeader.tsx
import Link from 'next/link';

export function PageHeader({
  title,
  crumbs,
  actions,
}: {
  title: React.ReactNode;
  crumbs: { label: string; href?: string }[];
  actions?: React.ReactNode;
}) {
  return (
    <header className="flex flex-col gap-3 border-b px-6 py-4 sm:flex-row sm:items-end sm:justify-between">
      <div className="min-w-0">
        <nav aria-label="Breadcrumb" className="mb-1 flex items-center gap-1 text-xs text-muted-foreground">
          {crumbs.map((c, i) => (
            <span key={i} className="flex items-center gap-1">
              {i > 0 && <span aria-hidden>/</span>}
              {c.href ? <Link href={c.href} className="hover:text-foreground">{c.label}</Link> : <span>{c.label}</span>}
            </span>
          ))}
        </nav>
        <h1 className="truncate text-xl font-semibold tracking-tight">{title}</h1>
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}
```

```tsx
// apps/web/components/dashboard/MobileNav.tsx
'use client';
import { Menu } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from '@/components/ui/sheet';

export function MobileNav({ children }: { children: React.ReactNode }) {
  return (
    <Sheet>
      <SheetTrigger asChild>
        <Button variant="ghost" size="icon" className="md:hidden" aria-label="Open navigation">
          <Menu className="size-5" />
        </Button>
      </SheetTrigger>
      <SheetContent side="left" className="w-64 bg-sidebar p-0">
        <SheetTitle className="sr-only">Navigation</SheetTitle>
        <div className="flex h-full flex-col">{children}</div>
      </SheetContent>
    </Sheet>
  );
}
```

```tsx
// apps/web/app/dashboard/[org]/[app]/layout.tsx
import { notFound } from 'next/navigation';
import { requireSession } from '@/src/auth';
import { getApp, listApps, listOrgs } from '@/src/dashboard-api';
import { AppSwitcher } from '@/components/dashboard/AppSwitcher';
import { groupForSwitcher } from '@/components/dashboard/switcher';
import { MobileNav } from '@/components/dashboard/MobileNav';
import { RememberApp } from '@/components/dashboard/RememberApp';
import { Sidebar, SidebarNav } from '@/components/dashboard/Sidebar';
import { LogoutButton } from '@/app/_components/LogoutButton';

export default async function AppShell({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ org: string; app: string }>;
}) {
  const { org, app } = await params;
  const base = `/dashboard/${encodeURIComponent(org)}/${encodeURIComponent(app)}`;
  const session = await requireSession(`${base}/queries`);
  const t = session.accessToken;

  const [orgsRes, appRes] = await Promise.all([listOrgs(t), getApp(t, app)]);
  if (!orgsRes.ok) throw new Error('Could not load workspaces');
  const currentOrg = orgsRes.data.find((o) => o.slug === org);
  // 403 and 404 both render not-found: never hint whether something exists.
  if (!currentOrg || !appRes.ok || appRes.data.orgId !== currentOrg.id) {
    if (!appRes.ok && appRes.status >= 500) throw new Error('Could not load app');
    notFound();
  }

  const appsByOrg = Object.fromEntries(
    await Promise.all(orgsRes.data.map(async (o) => {
      const r = await listApps(t, o.slug);
      return [o.slug, r.ok ? r.data : []] as const;
    })),
  );
  const groups = groupForSwitcher(orgsRes.data, appsByOrg, { org, app });
  const switcher = (
    <AppSwitcher
      groups={groups}
      currentLabel={{ org: currentOrg.name, app: appRes.data.name }}
      newAppHref={`/onboarding?org=${encodeURIComponent(org)}`}
    />
  );
  const nav = <SidebarNav base={base} active="queries" />;
  const footer = (
    <div className="flex flex-col gap-2 text-sm">
      <span className="truncate text-muted-foreground">{session.user.email}</span>
      <LogoutButton />
    </div>
  );

  return (
    <div className="flex min-h-screen">
      <RememberApp org={org} app={app} />
      <Sidebar switcher={switcher} nav={nav} footer={footer} />
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center gap-2 border-b px-3 py-2 md:hidden">
          <MobileNav>
            <div className="p-3">{switcher}</div>
            <div className="flex-1 py-2">{nav}</div>
            <div className="border-t p-3">{footer}</div>
          </MobileNav>
          <span className="truncate text-sm font-medium">{appRes.data.name}</span>
        </div>
        <main className="flex-1">{children}</main>
      </div>
    </div>
  );
}
```

```tsx
// apps/web/app/dashboard/[org]/[app]/page.tsx
import { redirect } from 'next/navigation';

export default async function AppIndex({ params }: { params: Promise<{ org: string; app: string }> }) {
  const { org, app } = await params;
  redirect(`/dashboard/${encodeURIComponent(org)}/${encodeURIComponent(app)}/queries`);
}
```

```tsx
// apps/web/app/dashboard/[org]/[app]/not-found.tsx
import Link from 'next/link';
import { Button } from '@/components/ui/button';

export default function NotFound() {
  return (
    <div className="mx-auto flex max-w-md flex-col items-center gap-3 px-6 py-24 text-center">
      <h2 className="text-lg font-semibold">Not found, or you don&apos;t have access</h2>
      <p className="text-sm text-muted-foreground">Check the link, or go back to your dashboard.</p>
      <Button asChild><Link href="/dashboard">Go to dashboard</Link></Button>
    </div>
  );
}
```

```tsx
// apps/web/app/dashboard/[org]/[app]/error.tsx  (and identical apps/web/app/dashboard/error.tsx)
'use client';
import { Button } from '@/components/ui/button';

export default function DashboardError({ reset }: { error: Error; reset: () => void }) {
  return (
    <div className="mx-auto flex max-w-md flex-col items-center gap-3 px-6 py-24 text-center">
      <h2 className="text-lg font-semibold">Couldn&apos;t load this page</h2>
      <p className="text-sm text-muted-foreground">The service may be briefly unavailable. Your data is safe.</p>
      <Button onClick={reset}>Retry</Button>
    </div>
  );
}
```

Restyle Plan B's `LogoutButton` to use `<Button variant="ghost" size="sm" className="justify-start px-0">` only if its markup is plain; do not change its behaviour.

- [ ] **Step 4: Run tests, typecheck, build**

Run: `pnpm --filter web test && pnpm --filter web exec tsc --noEmit && pnpm --filter web build` → PASS. Mutation: mark every app `current: true` in `groupForSwitcher` → test fails; revert.

- [ ] **Step 5: Commit**

```bash
git add apps/web/components/dashboard apps/web/app/dashboard apps/web/src/switcher.test.ts apps/web/src/landing.ts apps/web/src/landing.test.ts apps/web/app/_components/LogoutButton.tsx
git commit -m "feat(web): dashboard shell — sidebar, org/app switcher, fallbacks"
```

---

### Task 6: Onboarding

**Files:**
- Create: `apps/web/src/route-session.ts`, `apps/web/src/upstream-errors.ts`, `apps/web/src/onboarding-state.ts`, `apps/web/app/api/onboarding/org/route.ts`, `apps/web/app/api/onboarding/app/route.ts`, `apps/web/app/api/auth/verify-request/route.ts`, `apps/web/app/api/apps/[id]/status/route.ts`, `apps/web/app/onboarding/page.tsx`, `apps/web/components/onboarding/OnboardingFlow.tsx`, `VerifyStep.tsx`, `OrgStep.tsx`, `AppStep.tsx`, `InstallStep.tsx`, `snippet.ts`
- Test: `apps/web/src/onboarding-state.test.ts`, `apps/web/src/onboarding-routes.test.ts`, `apps/web/src/upstream-errors.test.ts`, `apps/web/src/snippet.test.ts`, `apps/web/components/onboarding/InstallStep.test.tsx`

**Interfaces:**
- Consumes: `getSession` (`@/src/auth`), `authedFetch`, `apiOrigin` (`@/src/api`), `rejectCrossSiteAuthPost`, `upstreamAuthHeaders`, `listOrgs`, `listApps`, `getMe`, `appPath`.
- Produces:
  - `sessionOr401(): Promise<{ session: Session } | { response: Response }>` — route-handler gate returning `NextResponse.json({error:'unauthorized'},{status:401})`.
  - `safeUpstreamMessage(status: number, kind: 'org' | 'app' | 'generic'): string` — 409 app → "An app with that name already exists in this workspace."; 409 org → "That workspace name is taken — try another."; 400 → "Please check the name and try again."; 403 → "You don't have permission to do that."; 429 → "Too many attempts — wait a minute and try again."; anything else → "Something went wrong. Please try again."
  - `type OnboardingStep = 'verify' | 'org' | 'app' | 'install'`; `resolveOnboardingStart(input: { emailVerified: boolean; orgs: { slug: string }[]; targetOrg?: string }): { step: 'verify' | 'org' | 'app'; org?: string }`
  - `buildSnippet(key: string, appName: string): { install: string; code: string }` — `code` is the `init({...})` block from `packages/sdk/README.md` with the key and app name inlined (JSON-escaped).
  - `POST /api/onboarding/org` body `{name}` → 201 `{slug, name}` | 4xx `{error}`
  - `POST /api/onboarding/app` body `{org, name}` → 201 `{app: {id, name}, key: string}` | 4xx `{error}` (creates app then key; if key creation fails, returns 201 `{app, key: null}` and the UI offers "Create key")
  - `POST /api/auth/verify-request` → always 202 `{status:'sent'}` (same anti-enumeration shape as password-request)
  - `GET /api/apps/[id]/status` → 200 `{lastSeenAt: string | null}` | 401 | 404; `Cache-Control: no-store`

- [ ] **Step 1: Write the failing tests**

```ts
// apps/web/src/onboarding-state.test.ts
import { describe, it, expect } from 'vitest';
import { resolveOnboardingStart } from './onboarding-state';

describe('resolveOnboardingStart', () => {
  it('unverified starts at verify', () =>
    expect(resolveOnboardingStart({ emailVerified: false, orgs: [{ slug: 'a' }] })).toEqual({ step: 'verify' }));
  it('no org starts at org', () =>
    expect(resolveOnboardingStart({ emailVerified: true, orgs: [] })).toEqual({ step: 'org' }));
  it('with an org starts at app for the first org', () =>
    expect(resolveOnboardingStart({ emailVerified: true, orgs: [{ slug: 'a' }, { slug: 'b' }] })).toEqual({ step: 'app', org: 'a' }));
  it('targetOrg (from "+ New app") is honoured when the user belongs to it', () =>
    expect(resolveOnboardingStart({ emailVerified: true, orgs: [{ slug: 'a' }, { slug: 'b' }], targetOrg: 'b' })).toEqual({ step: 'app', org: 'b' }));
  it('targetOrg the user does not belong to is ignored', () =>
    expect(resolveOnboardingStart({ emailVerified: true, orgs: [{ slug: 'a' }], targetOrg: 'zzz' })).toEqual({ step: 'app', org: 'a' }));
  it('never starts at install — the key step is only reachable with a key in memory', () => {
    for (const orgs of [[], [{ slug: 'a' }]]) {
      expect(resolveOnboardingStart({ emailVerified: true, orgs }).step).not.toBe('install');
    }
  });
});
```

```ts
// apps/web/src/upstream-errors.test.ts
import { describe, it, expect } from 'vitest';
import { safeUpstreamMessage } from './upstream-errors';

describe('safeUpstreamMessage', () => {
  it('409 maps to message (app)', () => expect(safeUpstreamMessage(409, 'app')).toMatch(/already exists/));
  it('409 maps to message (org)', () => expect(safeUpstreamMessage(409, 'org')).toMatch(/taken/));
  it('429', () => expect(safeUpstreamMessage(429, 'generic')).toMatch(/Too many/));
  it('unknown status is generic, never echoes anything', () => expect(safeUpstreamMessage(502, 'app')).toBe('Something went wrong. Please try again.'));
});
```

```ts
// apps/web/src/snippet.test.ts
import { describe, it, expect } from 'vitest';
import { buildSnippet } from '@/components/onboarding/snippet';

describe('buildSnippet', () => {
  it('inlines key and app name', () => {
    const s = buildSnippet('qa_live_abc', 'my-service');
    expect(s.install).toBe('npm install @vivekumar08/query-analyser');
    expect(s.code).toContain(`apiKey: "qa_live_abc"`);
    expect(s.code).toContain(`app: "my-service"`);
    expect(s.code).toContain(`require('@vivekumar08/query-analyser').init({`);
  });
  it('escapes quotes in the app name', () =>
    expect(buildSnippet('k', 'a"b').code).toContain('app: "a\\"b"'));
});
```

```ts
// apps/web/src/onboarding-routes.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/src/auth', () => ({ getSession: vi.fn() }));
vi.mock('@/src/api', () => ({ apiOrigin: () => 'https://api.test', authedFetch: vi.fn() }));
import { getSession } from '@/src/auth';
import { authedFetch } from '@/src/api';
import { POST as createOrg } from '@/app/api/onboarding/org/route';
import { POST as createApp } from '@/app/api/onboarding/app/route';
import { GET as status } from '@/app/api/apps/[id]/status/route';

const ORIGIN = 'https://app.test';
const session = { accessToken: 'tok', user: { id: 'u', email: 'e', name: 'n', isPlatformAdmin: false, emailVerifiedAt: 'x' } };
const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  new Request(`${ORIGIN}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ORIGIN, host: 'app.test', ...headers },
    body: JSON.stringify(body),
  });

beforeEach(() => {
  process.env.WEB_ORIGIN = ORIGIN;
  vi.mocked(getSession).mockResolvedValue(session as never);
  vi.mocked(authedFetch).mockReset();
});

describe('POST /api/onboarding/org', () => {
  it('rejects a cross-site post before touching the API', async () => {
    const res = await createOrg(post('/api/onboarding/org', { name: 'Acme' }, { origin: 'https://evil.test' }));
    expect(res.status).toBe(403);
    expect(authedFetch).not.toHaveBeenCalled();
  });
  it('401 without a session', async () => {
    vi.mocked(getSession).mockResolvedValue(null);
    expect((await createOrg(post('/api/onboarding/org', { name: 'Acme' }))).status).toBe(401);
  });
  it('creates the org with the token server-side', async () => {
    vi.mocked(authedFetch).mockResolvedValue({ ok: true, data: { slug: 'acme', name: 'Acme' } });
    const res = await createOrg(post('/api/onboarding/org', { name: 'Acme' }));
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ slug: 'acme', name: 'Acme' });
    expect(vi.mocked(authedFetch).mock.calls[0]![1]).toBe('tok');
  });
  it('409 maps to message, never the raw body', async () => {
    vi.mocked(authedFetch).mockResolvedValue({ ok: false, status: 409, error: 'internal detail' });
    const res = await createOrg(post('/api/onboarding/org', { name: 'Acme' }));
    const body = await res.json();
    expect(res.status).toBe(409);
    expect(body.error).toMatch(/taken/);
    expect(JSON.stringify(body)).not.toContain('internal detail');
  });
});

describe('POST /api/onboarding/app', () => {
  it('creates app then key and returns the key exactly once in the body', async () => {
    vi.mocked(authedFetch)
      .mockResolvedValueOnce({ ok: true, data: { id: 'a1', name: 'svc' } })
      .mockResolvedValueOnce({ ok: true, data: { id: 'k1', prefix: 'qa_', key: 'qa_secret' } });
    const res = await createApp(post('/api/onboarding/app', { org: 'acme', name: 'svc' }));
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ app: { id: 'a1', name: 'svc' }, key: 'qa_secret' });
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('location')).toBeNull();
  });
  it('key creation failure still returns the app, with key null', async () => {
    vi.mocked(authedFetch)
      .mockResolvedValueOnce({ ok: true, data: { id: 'a1', name: 'svc' } })
      .mockResolvedValueOnce({ ok: false, status: 500, error: 'x' });
    const res = await createApp(post('/api/onboarding/app', { org: 'acme', name: 'svc' }));
    expect(await res.json()).toEqual({ app: { id: 'a1', name: 'svc' }, key: null });
  });
  it('rejects an invalid body', async () => {
    expect((await createApp(post('/api/onboarding/app', { org: '', name: '' }))).status).toBe(400);
  });
});

describe('GET /api/apps/[id]/status', () => {
  it('returns only lastSeenAt, no-store', async () => {
    vi.mocked(authedFetch).mockResolvedValue({ ok: true, data: { id: 'a1', name: 'svc', ingest: { lastSeenAt: '2026-10-18T00:00:00.000Z', keyCount: 1 } } });
    const res = await status(new Request(`${ORIGIN}/api/apps/a1/status`), { params: Promise.resolve({ id: 'a1' }) });
    expect(await res.json()).toEqual({ lastSeenAt: '2026-10-18T00:00:00.000Z' });
    expect(res.headers.get('cache-control')).toBe('no-store');
  });
  it('maps upstream 403/404 to 404', async () => {
    vi.mocked(authedFetch).mockResolvedValue({ ok: false, status: 403, error: 'x' });
    const res = await status(new Request(`${ORIGIN}/api/apps/a1/status`), { params: Promise.resolve({ id: 'a1' }) });
    expect(res.status).toBe(404);
  });
});
```

(Read `src/same-origin-guard.test.ts` first and make the `post()` helper produce exactly what the guard accepts in tests; adjust `WEB_ORIGIN`/host handling to match.)

```tsx
// @vitest-environment jsdom
// apps/web/components/onboarding/InstallStep.test.tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { InstallStep } from './InstallStep';

describe('InstallStep', () => {
  it('shows the one-time key notice and the key in the snippet', () => {
    render(<InstallStep appId="a1" appName="svc" ingestKey="qa_secret" doneHref="/dashboard/acme/a1/queries" />);
    expect(screen.getByText(/shown once/i)).toBeTruthy();
    expect(screen.getByText(/qa_secret/)).toBeTruthy();
  });
  it('without a key in memory shows "already shown" and no key', () => {
    render(<InstallStep appId="a1" appName="svc" ingestKey={null} doneHref="/x" />);
    expect(screen.getByText(/already shown/i)).toBeTruthy();
    expect(screen.queryByText(/qa_/)).toBeNull();
  });
  it('leaving before copying asks for confirmation', () => {
    render(<InstallStep appId="a1" appName="svc" ingestKey="qa_secret" doneHref="/x" />);
    fireEvent.click(screen.getByRole('button', { name: /skip|go to/i }));
    expect(screen.getByText(/haven.t copied your key/i)).toBeTruthy();
  });
});
```

Mock `fetch` in this test (`vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ lastSeenAt: null }))))`) so polling does not hit the network; use fake timers if needed.

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter web test src/onboarding-state.test.ts src/upstream-errors.test.ts src/snippet.test.ts src/onboarding-routes.test.ts components/onboarding/InstallStep.test.tsx` → FAIL.

- [ ] **Step 3: Implement the pure modules**

```ts
// apps/web/src/onboarding-state.ts
export type OnboardingStep = 'verify' | 'org' | 'app' | 'install';

export function resolveOnboardingStart(input: {
  emailVerified: boolean;
  orgs: { slug: string }[];
  targetOrg?: string;
}): { step: 'verify' | 'org' | 'app'; org?: string } {
  if (!input.emailVerified) return { step: 'verify' };
  if (input.orgs.length === 0) return { step: 'org' };
  const target = input.orgs.find((o) => o.slug === input.targetOrg) ?? input.orgs[0]!;
  return { step: 'app', org: target.slug };
}
```

```ts
// apps/web/src/upstream-errors.ts
export function safeUpstreamMessage(status: number, kind: 'org' | 'app' | 'generic'): string {
  if (status === 409 && kind === 'app') return 'An app with that name already exists in this workspace.';
  if (status === 409 && kind === 'org') return 'That workspace name is taken — try another.';
  if (status === 400) return 'Please check the name and try again.';
  if (status === 403) return "You don't have permission to do that.";
  if (status === 429) return 'Too many attempts — wait a minute and try again.';
  return 'Something went wrong. Please try again.';
}
```

```ts
// apps/web/src/route-session.ts
import { NextResponse } from 'next/server';
import { getSession, type Session } from './auth';

/** Route-handler gate: the session, or a 401 to return. Never redirects. */
export async function sessionOr401(): Promise<{ session: Session } | { response: Response }> {
  const session = await getSession();
  if (!session) return { response: NextResponse.json({ error: 'unauthorized' }, { status: 401 }) };
  return { session };
}
```

```ts
// apps/web/components/onboarding/snippet.ts
export function buildSnippet(key: string, appName: string): { install: string; code: string } {
  return {
    install: 'npm install @vivekumar08/query-analyser',
    code: [
      `require('@vivekumar08/query-analyser').init({`,
      `  apiKey: ${JSON.stringify(key)},`,
      `  app: ${JSON.stringify(appName)},`,
      `});`,
    ].join('\n'),
  };
}
```

(The README uses `process.env.QA_KEY`; inlining is deliberate for copy-paste onboarding. Add a one-line note under the snippet in the UI: "Prefer an environment variable in production: `apiKey: process.env.QA_KEY`.")

- [ ] **Step 4: Implement the route handlers**

```ts
// apps/web/app/api/onboarding/org/route.ts
import { NextResponse } from 'next/server';
import { authedFetch } from '@/src/api';
import { rejectCrossSiteAuthPost } from '@/src/same-origin-guard';
import { sessionOr401 } from '@/src/route-session';
import { safeUpstreamMessage } from '@/src/upstream-errors';

export async function POST(request: Request): Promise<Response> {
  const rejected = rejectCrossSiteAuthPost(request);
  if (rejected) return rejected;
  const gate = await sessionOr401();
  if ('response' in gate) return gate.response;

  const body = (await request.json().catch(() => null)) as { name?: unknown } | null;
  const name = typeof body?.name === 'string' ? body.name.trim() : '';
  if (name.length < 2 || name.length > 60) {
    return NextResponse.json({ error: 'Workspace name must be 2–60 characters.' }, { status: 400 });
  }

  const res = await authedFetch<{ slug: string; name: string }>('/v1/orgs', gate.session.accessToken, {
    method: 'POST',
    body: JSON.stringify({ name }),
  });
  if (!res.ok) return NextResponse.json({ error: safeUpstreamMessage(res.status, 'org') }, { status: res.status >= 500 ? 502 : res.status });
  return NextResponse.json({ slug: res.data.slug, name: res.data.name }, { status: 201 });
}
```

```ts
// apps/web/app/api/onboarding/app/route.ts
import { NextResponse } from 'next/server';
import { authedFetch } from '@/src/api';
import { rejectCrossSiteAuthPost } from '@/src/same-origin-guard';
import { sessionOr401 } from '@/src/route-session';
import { safeUpstreamMessage } from '@/src/upstream-errors';

/**
 * Creates the app and its first ingest key. The key's plaintext leaves the
 * server exactly here, once, in this JSON body — never a cookie, URL or
 * redirect — and `no-store` keeps any cache from holding it.
 */
export async function POST(request: Request): Promise<Response> {
  const rejected = rejectCrossSiteAuthPost(request);
  if (rejected) return rejected;
  const gate = await sessionOr401();
  if ('response' in gate) return gate.response;
  const t = gate.session.accessToken;

  const body = (await request.json().catch(() => null)) as { org?: unknown; name?: unknown } | null;
  const org = typeof body?.org === 'string' ? body.org : '';
  const name = typeof body?.name === 'string' ? body.name.trim() : '';
  if (!org || name.length < 1 || name.length > 60) {
    return NextResponse.json({ error: 'App name must be 1–60 characters.' }, { status: 400 });
  }

  const created = await authedFetch<{ id: string; name: string }>(`/v1/orgs/${encodeURIComponent(org)}/apps`, t, {
    method: 'POST',
    body: JSON.stringify({ name }),
  });
  if (!created.ok) {
    return NextResponse.json({ error: safeUpstreamMessage(created.status, 'app') }, { status: created.status >= 500 ? 502 : created.status });
  }
  const key = await authedFetch<{ key: string }>(`/v1/apps/${encodeURIComponent(created.data.id)}/keys`, t, { method: 'POST' });

  return NextResponse.json(
    { app: { id: created.data.id, name: created.data.name }, key: key.ok ? key.data.key : null },
    { status: 201, headers: { 'cache-control': 'no-store' } },
  );
}
```

Check `POST /v1/orgs/:org/apps`'s create schema in `apps/api/src/apps/routes.ts` (it may require `env`); if so send `env: 'production'` (use the schema's default value name exactly) and add that to the test's expectations.

```ts
// apps/web/app/api/auth/verify-request/route.ts
import { NextResponse } from 'next/server';
import { authedFetch } from '@/src/api';
import { rejectCrossSiteAuthPost } from '@/src/same-origin-guard';
import { sessionOr401 } from '@/src/route-session';

/** Resend the verification email. Same 202 whatever happens upstream. */
export async function POST(request: Request): Promise<Response> {
  const rejected = rejectCrossSiteAuthPost(request);
  if (rejected) return rejected;
  const gate = await sessionOr401();
  if ('response' in gate) return gate.response;
  await authedFetch('/v1/auth/verify/request', gate.session.accessToken, { method: 'POST', body: '{}' }).catch(() => null);
  return NextResponse.json({ status: 'sent' }, { status: 202 });
}
```

Read `apps/api/src/auth/routes.ts:120-150` first: if `/v1/auth/verify/request` takes `{ email }` without auth (rate-limited per IP), call it with `upstreamAuthHeaders(request, { 'content-type': 'application/json' })` and `body: JSON.stringify({ email: gate.session.user.email })` via `fetch(apiOrigin()+…)` like `password-request/route.ts`, instead of `authedFetch`. Add a route test either way: cross-site → 403; good → 202.

```ts
// apps/web/app/api/apps/[id]/status/route.ts
import { NextResponse } from 'next/server';
import { getApp } from '@/src/dashboard-api';
import { sessionOr401 } from '@/src/route-session';

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const gate = await sessionOr401();
  if ('response' in gate) return gate.response;
  const { id } = await params;
  const res = await getApp(gate.session.accessToken, id);
  const headers = { 'cache-control': 'no-store' };
  if (!res.ok) {
    return NextResponse.json({ error: 'not found' }, { status: res.status === 401 ? 401 : res.status >= 500 ? 502 : 404, headers });
  }
  return NextResponse.json({ lastSeenAt: res.data.ingest.lastSeenAt }, { headers });
}
```

(The status test mocks `@/src/api`'s `authedFetch`; `getApp` calls it, so the mock applies.)

- [ ] **Step 5: Implement the onboarding page and steps**

```tsx
// apps/web/app/onboarding/page.tsx
import { requireSession } from '@/src/auth';
import { listOrgs } from '@/src/dashboard-api';
import { resolveOnboardingStart } from '@/src/onboarding-state';
import { OnboardingFlow } from '@/components/onboarding/OnboardingFlow';

export default async function OnboardingPage({ searchParams }: { searchParams: Promise<{ org?: string }> }) {
  const { org: targetOrg } = await searchParams;
  const session = await requireSession(targetOrg ? `/onboarding?org=${encodeURIComponent(targetOrg)}` : '/onboarding');
  const verified = Boolean(session.user.emailVerifiedAt);
  // /v1/orgs requires a verified email; don't call it before then.
  const orgsRes = verified ? await listOrgs(session.accessToken) : null;
  if (orgsRes && !orgsRes.ok) throw new Error('Could not load workspaces');
  const orgs = orgsRes?.ok ? orgsRes.data : [];
  const start = resolveOnboardingStart({ emailVerified: verified, orgs, targetOrg });

  return (
    <main className="mx-auto grid min-h-screen max-w-4xl gap-10 px-6 py-16 md:grid-cols-[220px_1fr]">
      <OnboardingFlow start={start} email={session.user.email} />
    </main>
  );
}
```

`OnboardingFlow` is a client component holding `{ step, org, app: {id,name} | null, key: string | null }` in React state only (never storage). It renders a vertical step list (`verify`, `org`, `app`, `install` with done/active/pending styles, `aria-current="step"` on the active one) and the active step:

```tsx
// apps/web/components/onboarding/OnboardingFlow.tsx
'use client';
import { useState } from 'react';
import { Check } from 'lucide-react';
import { cn } from '@/lib/utils';
import { appPath } from '@/src/landing';
import { VerifyStep } from './VerifyStep';
import { OrgStep } from './OrgStep';
import { AppStep } from './AppStep';
import { InstallStep } from './InstallStep';

type Step = 'verify' | 'org' | 'app' | 'install';
const STEPS: { id: Step; label: string }[] = [
  { id: 'verify', label: 'Verify your email' },
  { id: 'org', label: 'Name your workspace' },
  { id: 'app', label: 'Create your first app' },
  { id: 'install', label: 'Install' },
];

export function OnboardingFlow({ start, email }: { start: { step: 'verify' | 'org' | 'app'; org?: string }; email: string }) {
  const [step, setStep] = useState<Step>(start.step);
  const [org, setOrg] = useState<string | undefined>(start.org);
  const [app, setApp] = useState<{ id: string; name: string } | null>(null);
  const [key, setKey] = useState<string | null>(null);
  const index = STEPS.findIndex((s) => s.id === step);

  return (
    <>
      <ol className="flex flex-col gap-4 text-sm">
        {STEPS.map((s, i) => (
          <li key={s.id} aria-current={s.id === step ? 'step' : undefined} className="flex items-center gap-3">
            <span className={cn('flex size-6 items-center justify-center rounded-full border text-xs',
              i < index && 'border-primary bg-primary text-primary-foreground',
              i === index && 'border-primary text-primary',
              i > index && 'text-muted-foreground')}>
              {i < index ? <Check className="size-3.5" aria-hidden /> : i + 1}
            </span>
            <span className={cn(i === index ? 'font-medium' : 'text-muted-foreground')}>{s.label}</span>
          </li>
        ))}
      </ol>
      <section>
        {step === 'verify' && <VerifyStep email={email} onVerified={() => window.location.assign('/onboarding')} />}
        {step === 'org' && <OrgStep onCreated={(slug) => { setOrg(slug); setStep('app'); }} />}
        {step === 'app' && org && (
          <AppStep org={org} onCreated={(a, k) => { setApp(a); setKey(k); setStep('install'); }} />
        )}
        {step === 'install' && app && org && (
          <InstallStep appId={app.id} appName={app.name} ingestKey={key} doneHref={appPath(org, app.id)} />
        )}
      </section>
    </>
  );
}
```

(After verification the page reloads so the server re-resolves the start step with fresh `/v1/me`.)

`VerifyStep`: heading "Verify your email", text "We sent a link to **{email}**. Click it, then come back here.", **Resend email** (`fetch('/api/auth/verify-request', {method:'POST', headers:{'content-type':'application/json'}, body:'{}'})`, toast "Email sent"), **I've verified, continue** (calls `onVerified`); also re-checks on `visibilitychange` → visible by calling `onVerified` only if `fetch('/api/onboarding/me-verified')`… — simpler and sufficient: on focus, call `router.refresh()`; the server component re-renders with the new start step. Use `router.refresh()` for both the button and focus, not a new endpoint.

`OrgStep`: shadcn `Card` with a form: `Label` "Workspace name", `Input` (autoFocus, 2–60 chars), helper "Usually your company or team name." Submit → `POST /api/onboarding/org` with JSON; on 201 call `onCreated(slug)`; on error `toast.error(body.error)`. Button disabled + spinner (`Loader2` animate-spin) while pending.

`AppStep`: same pattern, label "App name", placeholder `my-service`, helper "The name your service reports as. You can add more apps later." → `POST /api/onboarding/app` `{org, name}` → `onCreated(app, key)`.

```tsx
// apps/web/components/onboarding/InstallStep.tsx
'use client';
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { motion, useReducedMotion } from 'framer-motion';
import { AlertTriangle, CheckCircle2, Copy, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { buildSnippet } from './snippet';

const POLL_MS = 5000;
const HELP_AFTER_MS = 180_000;

export function InstallStep({
  appId, appName, ingestKey, doneHref,
}: { appId: string; appName: string; ingestKey: string | null; doneHref: string }) {
  const router = useRouter();
  const reduce = useReducedMotion();
  const [copied, setCopied] = useState(false);
  const [confirmLeave, setConfirmLeave] = useState(false);
  const [connected, setConnected] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const started = useRef(Date.now());

  useEffect(() => {
    if (connected) return;
    let stopped = false;
    const tick = async () => {
      if (document.visibilityState !== 'visible') return;
      try {
        const res = await fetch(`/api/apps/${encodeURIComponent(appId)}/status`, { cache: 'no-store' });
        if (!res.ok) throw new Error(String(res.status));
        const body = (await res.json()) as { lastSeenAt: string | null };
        setReconnecting(false);
        if (body.lastSeenAt && !stopped) setConnected(true);
      } catch {
        setReconnecting(true);
      }
      if (Date.now() - started.current > HELP_AFTER_MS) setShowHelp(true);
    };
    void tick();
    const id = setInterval(tick, POLL_MS);
    return () => { stopped = true; clearInterval(id); };
  }, [appId, connected]);

  if (!ingestKey) {
    return (
      <Card>
        <CardHeader><CardTitle>Key already shown</CardTitle></CardHeader>
        <CardContent className="flex flex-col gap-3 text-sm text-muted-foreground">
          <p>For your security an ingest key is only shown once. Create a new key from Settings (coming soon), or create another app.</p>
          <Button asChild variant="outline" className="self-start"><Link href={doneHref}>Go to your queries</Link></Button>
        </CardContent>
      </Card>
    );
  }

  const s = buildSnippet(ingestKey, appName);
  const copy = async (text: string, what: string) => {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    toast.success(`${what} copied`);
  };
  const leave = () => (copied ? router.push(doneHref) : setConfirmLeave(true));

  return (
    <div className="flex flex-col gap-5">
      <h2 className="text-xl font-semibold tracking-tight">Install the agent</h2>
      <div role="note" className="flex gap-2 rounded-lg border border-amber-200 bg-warning-bg p-3 text-sm text-warning-fg">
        <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
        <p><strong>This key is shown once.</strong> Copy it now — we can&apos;t show it again.</p>
      </div>
      <pre className="overflow-x-auto rounded-lg border bg-muted p-4 font-mono text-sm"><code>{s.install}{'\n\n'}{s.code}</code></pre>
      <p className="text-xs text-muted-foreground">Prefer an environment variable in production: <code className="font-mono">apiKey: process.env.QA_KEY</code>.</p>
      <div className="flex flex-wrap gap-2">
        <Button onClick={() => copy(`${s.install}\n\n${s.code}`, 'Snippet')}><Copy className="size-4" /> Copy snippet</Button>
        <Button variant="outline" onClick={() => copy(ingestKey, 'Key')}><Copy className="size-4" /> Copy key</Button>
      </div>

      <Card aria-live="polite">
        <CardContent className="flex items-center gap-3 py-4">
          {connected ? (
            <motion.div initial={reduce ? false : { scale: 0.9, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} className="flex flex-1 items-center gap-3">
              <CheckCircle2 className="size-5 text-emerald-600" aria-hidden />
              <span className="font-medium">Connected — your first batch arrived.</span>
            </motion.div>
          ) : (
            <div className="flex flex-1 items-center gap-3 text-sm text-muted-foreground">
              <span className="relative flex size-2.5">
                {!reduce && <span className="absolute inline-flex size-full animate-ping rounded-full bg-primary/60" />}
                <span className="relative inline-flex size-2.5 rounded-full bg-primary" />
              </span>
              {reconnecting ? 'Reconnecting…' : 'Waiting for your first batch…'}
            </div>
          )}
          <Button variant={connected ? 'default' : 'ghost'} onClick={leave}>
            {connected ? 'Go to your queries →' : 'Skip for now'}
          </Button>
        </CardContent>
      </Card>

      {showHelp && !connected && (
        <Card>
          <CardHeader><CardTitle className="text-base">Not seeing data?</CardTitle></CardHeader>
          <CardContent>
            <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
              <li>The key is set in the running process (<code className="font-mono">QA_KEY</code> or inline).</li>
              <li>Your app uses mongoose 8.</li>
              <li>Only queries taking 100&nbsp;ms or more are reported — trigger a slow one.</li>
              <li>Batches ship every 10 seconds.</li>
            </ul>
          </CardContent>
        </Card>
      )}

      <AlertDialog open={confirmLeave} onOpenChange={setConfirmLeave}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>You haven&apos;t copied your key</AlertDialogTitle>
            <AlertDialogDescription>It won&apos;t be shown again. Leave anyway?</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Stay</AlertDialogCancel>
            <AlertDialogAction onClick={() => router.push(doneHref)}>Leave</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
```

The InstallStep test must mock `next/navigation` (`useRouter: () => ({ push: vi.fn() })`) and stub `navigator.clipboard`. Also add a `beforeunload` listener while `!copied` (prevents tab close losing the key); test not required.

Update Plan B's login/signup/verify landing: they already go to `/dashboard`, which now routes to onboarding — no change needed. Confirm by reading `AuthForm.tsx` and `VerifyClient.tsx`.

- [ ] **Step 6: Run tests, typecheck, build**

Run: `pnpm --filter web test && pnpm --filter web exec tsc --noEmit && pnpm --filter web build` → PASS. Mutations: remove `rejectCrossSiteAuthPost` from `app/route.ts` (→ cross-site test fails — add the same cross-site case for app/route as for org/route); return `res.data.ingest` from status (→ "only lastSeenAt" fails); `resolveOnboardingStart` returning `'install'` when orgs exist (→ "never starts at install" fails). Revert each.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/route-session.ts apps/web/src/upstream-errors.ts apps/web/src/onboarding-state.ts apps/web/src/*onboarding*.test.ts apps/web/src/upstream-errors.test.ts apps/web/src/snippet.test.ts apps/web/app/api/onboarding apps/web/app/api/auth/verify-request apps/web/app/api/apps apps/web/app/onboarding apps/web/components/onboarding
git commit -m "feat(web): onboarding — verify, workspace, first app, one-time key and live check"
```

---

### Task 7: Queries page — range control, filters, table

**Files:**
- Create: `apps/web/components/dashboard/RangeControl.tsx`, `QueryFilters.tsx`, `QueriesTable.tsx`, `MiniHistogram.tsx`, `EmptyState.tsx`, `apps/web/src/queries-view.ts`, `apps/web/app/dashboard/[org]/[app]/queries/page.tsx`, `loading.tsx`
- Test: `apps/web/src/queries-view.test.ts`, `apps/web/components/dashboard/QueriesTable.test.tsx`, `apps/web/components/dashboard/EmptyState.test.tsx`

**Interfaces:**
- Consumes: `parseFilters`, `filtersToSearch`, `filtersToApiQuery`, `PAGE_SIZE`, `QueryFilters` (Task 2); `listQueries` (Task 4); `formatMs`, `formatAvg`, `formatCount`; `<Percentile>`; `<PageHeader>`.
- Produces:
  - `toRowsView(rows: QueryRow[]): { hash; title: string; signature; count; wasted: string; wastedShare: number /*0..1*/; avg: string; p95: PercentileResult | null; max: string; hist: number[] }[]` — `wastedShare` = row totalMs / page max totalMs, computed after `toMs`.
  - `emptyKind(input: { rows: number; filtered: boolean }): 'none' | 'no-data' | 'no-match'`
  - `<RangeControl value={RangeState} />` — client; updates URL search params (`range`, `from`, `to`), preserving others, via `router.replace` (no scroll).
  - `<QueryFilters models={string[]} ops={string[]} value={QueryFilters} />` — client; multi-select models/ops, sort select; preserves range; resets `limit`.

- [ ] **Step 1: Write the failing tests**

```ts
// apps/web/src/queries-view.test.ts
import { describe, it, expect } from 'vitest';
import { toRowsView, emptyKind } from './queries-view';

const row = (hash: string, totalMs: string, count: number) => ({
  hash, signature: `{ a: eq }`, model: 'Order', operation: 'find', count, totalMs, maxMs: 900, hist: [0, 1, 0, 0, 0, 0, 0, 0],
});

describe('toRowsView', () => {
  it('converts totalMs before computing share; worst row has share 1', () => {
    const v = toRowsView([row('a', '4000', 4), row('b', '1000', 2)] as never);
    expect(v[0]).toMatchObject({ title: 'Order.find', wasted: '4s', avg: '1s', wastedShare: 1 });
    expect(v[1]!.wastedShare).toBe(0.25);
  });
  it('all-zero totals give share 0, not NaN', () =>
    expect(toRowsView([row('a', '0', 0)] as never)[0]!.wastedShare).toBe(0));
});

describe('emptyKind', () => {
  it('rows → none', () => expect(emptyKind({ rows: 3, filtered: true })).toBe('none'));
  it('no rows, no filters → no-data', () => expect(emptyKind({ rows: 0, filtered: false })).toBe('no-data'));
  it('no rows with filters → no-match', () => expect(emptyKind({ rows: 0, filtered: true })).toBe('no-match'));
});
```

```tsx
// @vitest-environment jsdom
// apps/web/components/dashboard/QueriesTable.test.tsx
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueriesTable } from './QueriesTable';

describe('QueriesTable', () => {
  it('links each row to its detail page and renders p95 through Percentile', () => {
    render(
      <QueriesTable
        base="/dashboard/acme/a1"
        search="range=7d"
        rows={[{ hash: 'h1', title: 'Order.find', signature: '{ a: eq }', count: 12, wasted: '4s', wastedShare: 1, avg: '333ms', p95: { value: 900, basis: 'floor' }, max: '900ms', hist: [0, 1, 0, 0, 0, 0, 0, 0] }]}
      />,
    );
    expect(screen.getByRole('link', { name: /Order\.find/ }).getAttribute('href')).toBe('/dashboard/acme/a1/queries/h1?range=7d');
    expect(screen.getByText('≥ 900ms')).toBeTruthy();
  });
});
```

```tsx
// @vitest-environment jsdom
// apps/web/components/dashboard/EmptyState.test.tsx
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueriesEmpty } from './EmptyState';

describe('QueriesEmpty', () => {
  it('no-data explains what to do next', () => {
    render(<QueriesEmpty kind="no-data" clearHref="/x" installHref="/onboarding" />);
    expect(screen.getByText(/No queries ≥ 100ms in this window/)).toBeTruthy();
  });
  it('no-match offers clearing filters', () => {
    render(<QueriesEmpty kind="no-match" clearHref="/dashboard/acme/a1/queries" installHref="/onboarding" />);
    expect(screen.getByRole('link', { name: /clear filters/i }).getAttribute('href')).toBe('/dashboard/acme/a1/queries');
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter web test src/queries-view.test.ts components/dashboard/QueriesTable.test.tsx components/dashboard/EmptyState.test.tsx` → FAIL.

- [ ] **Step 3: Implement**

```ts
// apps/web/src/queries-view.ts
import type { PercentileResult } from '@query-analyser/contract';
import type { QueryRow } from './dashboard-types';
import { formatAvg, formatMs, toMs } from './format';

export interface RowView {
  hash: string; title: string; signature: string; count: number;
  wasted: string; wastedShare: number; avg: string;
  p95: PercentileResult | null; max: string; hist: number[];
}

export function toRowsView(rows: QueryRow[]): RowView[] {
  const totals = rows.map((r) => toMs(r.totalMs));
  const top = Math.max(0, ...totals);
  return rows.map((r, i) => ({
    hash: r.hash,
    title: `${r.model}.${r.operation}`,
    signature: r.signature,
    count: r.count,
    wasted: formatMs(totals[i]!),
    wastedShare: top > 0 ? totals[i]! / top : 0,
    avg: formatAvg(r.totalMs, r.count),
    p95: r.p95 ?? null,
    max: formatMs(r.maxMs),
    hist: r.hist,
  }));
}

export function emptyKind(input: { rows: number; filtered: boolean }): 'none' | 'no-data' | 'no-match' {
  if (input.rows > 0) return 'none';
  return input.filtered ? 'no-match' : 'no-data';
}
```

Check whether `GET /v1/apps/:id/queries` rows include `p95` (the API computes it for `sort=p95`; read `apps/api/src/analysis/routes.ts` list handler). If rows have no `p95`, compute it client-side is NOT allowed (duplicating the percentile rule); instead show `—` via `<Percentile value={null}>` and note it in the report.

```tsx
// apps/web/components/dashboard/MiniHistogram.tsx
export function MiniHistogram({ hist }: { hist: number[] }) {
  const max = Math.max(1, ...hist);
  return (
    <div className="flex h-5 items-end gap-px" aria-hidden>
      {hist.map((v, i) => (
        <span key={i} className="w-1.5 rounded-sm bg-primary/70" style={{ height: `${Math.max(v > 0 ? 12 : 4, (v / max) * 100)}%`, opacity: v > 0 ? 1 : 0.25 }} />
      ))}
    </div>
  );
}
```

```tsx
// apps/web/components/dashboard/QueriesTable.tsx
import Link from 'next/link';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import type { RowView } from '@/src/queries-view';
import { formatCount } from '@/src/format';
import { Percentile } from './Percentile';
import { MiniHistogram } from './MiniHistogram';

export function QueriesTable({ base, search, rows }: { base: string; search: string; rows: RowView[] }) {
  const q = search ? `?${search}` : '';
  return (
    <TooltipProvider delayDuration={200}>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-[40%]">Query</TableHead>
            <TableHead className="text-right">Calls</TableHead>
            <TableHead>Time wasted</TableHead>
            <TableHead className="text-right">Avg</TableHead>
            <TableHead className="text-right">p95</TableHead>
            <TableHead className="text-right">Max</TableHead>
            <TableHead className="hidden lg:table-cell">Distribution</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r) => (
            <TableRow key={r.hash} className="group">
              <TableCell className="max-w-0">
                <Link href={`${base}/queries/${encodeURIComponent(r.hash)}${q}`} className="block font-medium group-hover:text-primary">
                  {r.title}
                </Link>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <code className="block truncate font-mono text-xs text-muted-foreground">{r.signature}</code>
                  </TooltipTrigger>
                  <TooltipContent className="max-w-md font-mono text-xs">{r.signature}</TooltipContent>
                </Tooltip>
              </TableCell>
              <TableCell className="text-right tabular-nums">{formatCount(r.count)}</TableCell>
              <TableCell>
                <div className="flex items-center gap-2">
                  <span className="w-14 tabular-nums">{r.wasted}</span>
                  <span className="h-1.5 w-24 overflow-hidden rounded-full bg-muted">
                    <span className="block h-full rounded-full bg-primary" style={{ width: `${Math.round(r.wastedShare * 100)}%` }} />
                  </span>
                </div>
              </TableCell>
              <TableCell className="text-right tabular-nums">{r.avg}</TableCell>
              <TableCell className="text-right"><Percentile label="p95" showLabel={false} value={r.p95} /></TableCell>
              <TableCell className="text-right tabular-nums">{r.max}</TableCell>
              <TableCell className="hidden lg:table-cell"><MiniHistogram hist={r.hist} /></TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </TooltipProvider>
  );
}
```

```tsx
// apps/web/components/dashboard/EmptyState.tsx
import Link from 'next/link';
import { SearchX, Inbox } from 'lucide-react';
import { Button } from '@/components/ui/button';

export function QueriesEmpty({ kind, clearHref, installHref }: { kind: 'no-data' | 'no-match'; clearHref: string; installHref: string }) {
  const Icon = kind === 'no-data' ? Inbox : SearchX;
  return (
    <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed px-6 py-16 text-center">
      <Icon className="size-8 text-muted-foreground" aria-hidden />
      {kind === 'no-data' ? (
        <>
          <p className="font-medium">No queries ≥ 100ms in this window.</p>
          <p className="max-w-sm text-sm text-muted-foreground">Try a longer range like 7 days, or check that your app is sending data.</p>
          <Button asChild variant="outline"><Link href={installHref}>View install instructions</Link></Button>
        </>
      ) : (
        <>
          <p className="font-medium">No queries match these filters.</p>
          <Button asChild variant="outline"><Link href={clearHref}>Clear filters</Link></Button>
        </>
      )}
    </div>
  );
}
```

`installHref` for an existing app: `/onboarding?org=<org>` lands on "Create your first app" — instead link to the README install section `https://www.npmjs.com/package/@vivekumar08/query-analyser` (opens in a new tab) and keep the test's prop name; update the test expectation to the npm URL if you choose it.

```tsx
// apps/web/components/dashboard/RangeControl.tsx
'use client';
import { useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import type { DateRange } from 'react-day-picker';
import { CalendarDays } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Calendar } from '@/components/ui/calendar';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import type { RangePreset, RangeState } from '@/src/range';

const PRESETS: RangePreset[] = ['1h', '24h', '7d', '30d'];
const day = (d: Date) => d.toISOString().slice(0, 10);

export function RangeControl({ value }: { value: RangeState }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<DateRange | undefined>(
    value.kind === 'custom' ? { from: new Date(value.from), to: new Date(value.to) } : undefined,
  );

  const apply = (next: Record<string, string | null>) => {
    const s = new URLSearchParams(params.toString());
    for (const [k, v] of Object.entries(next)) (v === null ? s.delete(k) : s.set(k, v));
    s.delete('limit');
    const qs = s.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  };

  return (
    <div className="flex items-center gap-2">
      <ToggleGroup
        type="single"
        variant="outline"
        size="sm"
        value={value.kind === 'preset' ? value.preset : ''}
        onValueChange={(v) => v && apply({ range: v === '24h' ? null : v, from: null, to: null })}
        aria-label="Time range"
      >
        {PRESETS.map((p) => <ToggleGroupItem key={p} value={p}>{p}</ToggleGroupItem>)}
      </ToggleGroup>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button variant={value.kind === 'custom' ? 'secondary' : 'outline'} size="sm">
            <CalendarDays className="size-4" />
            {value.kind === 'custom' ? `${value.from.slice(0, 10)} → ${value.to.slice(0, 10)}` : 'Custom'}
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-auto p-0" align="end">
          <Calendar mode="range" numberOfMonths={2} selected={draft} onSelect={setDraft} disabled={{ after: new Date() }} />
          <div className="flex justify-end gap-2 border-t p-2">
            <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
            <Button size="sm" disabled={!draft?.from || !draft?.to}
              onClick={() => { apply({ range: 'custom', from: day(draft!.from!), to: day(draft!.to!) }); setOpen(false); }}>
              Apply
            </Button>
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}
```

(`toISOString().slice(0,10)` uses UTC; the calendar returns local midnight. Use `date-fns`' `format(d, 'yyyy-MM-dd')` instead so the picked local day is what is sent; `parseRange` interprets it as UTC day bounds — document "dates are UTC" in a small caption under the calendar.)

`QueryFilters` (client): two shadcn `Popover`+`Command` multi-selects ("Model", "Operation") listing the distinct values from the current unfiltered rows (the page passes `models`/`ops` derived from a first unfiltered fetch with `limit=500`, or from the current rows if filters are empty — use the current page's rows plus the selected values so selections never disappear), a sort `DropdownMenu` (Time wasted · Calls · p95 · Max), and a "Clear" button when any filter is set. All updates go through the same `apply` pattern (delete `limit`, keep `range`/`from`/`to`).

```tsx
// apps/web/app/dashboard/[org]/[app]/queries/page.tsx
import Link from 'next/link';
import { requireSession } from '@/src/auth';
import { listQueries } from '@/src/dashboard-api';
import { filtersToApiQuery, filtersToSearch, parseFilters, PAGE_SIZE } from '@/src/filters';
import { clearFiltersHref, emptyKind, toRowsView } from '@/src/queries-view';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { PageHeader } from '@/components/dashboard/PageHeader';
import { RangeControl } from '@/components/dashboard/RangeControl';
import { QueryFiltersBar } from '@/components/dashboard/QueryFilters';
import { QueriesTable } from '@/components/dashboard/QueriesTable';
import { QueriesEmpty } from '@/components/dashboard/EmptyState';

export default async function QueriesPage({
  params,
  searchParams,
}: {
  params: Promise<{ org: string; app: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { org, app } = await params;
  const sp = await searchParams;
  const base = `/dashboard/${encodeURIComponent(org)}/${encodeURIComponent(app)}`;
  const filters = parseFilters(sp);
  const search = filtersToSearch(filters);
  const session = await requireSession(`${base}/queries${search ? `?${search}` : ''}`);

  const res = await listQueries(session.accessToken, app, filtersToApiQuery(filters));
  if (!res.ok) throw new Error('Could not load queries');
  const rows = toRowsView(res.data);
  const filtered = filters.models.length > 0 || filters.ops.length > 0;
  const kind = emptyKind({ rows: rows.length, filtered });
  const models = [...new Set([...res.data.map((r) => r.model), ...filters.models])].sort();
  const ops = [...new Set([...res.data.map((r) => r.operation), ...filters.ops])].sort();
  const more = new URLSearchParams(search);
  more.set('limit', String(filters.limit + PAGE_SIZE));

  return (
    <>
      <PageHeader title="Queries" crumbs={[{ label: org }, { label: 'Queries' }]} actions={<RangeControl value={filters.range} />} />
      <div className="flex flex-col gap-4 p-6">
        <QueryFiltersBar models={models} ops={ops} value={filters} />
        {kind === 'none' ? (
          <Card className="overflow-hidden p-0">
            <QueriesTable base={base} search={search} rows={rows} />
          </Card>
        ) : (
          <QueriesEmpty kind={kind} clearHref={clearFiltersHref(base, filters)} installHref="https://www.npmjs.com/package/@vivekumar08/query-analyser" />
        )}
        {rows.length === filters.limit && (
          <Button asChild variant="outline" className="self-center">
            <Link href={`${base}/queries?${more.toString()}`} scroll={false}>Show more</Link>
          </Button>
        )}
      </div>
    </>
  );
}
```

Add to `queries-view.ts` (and its test file: `clearFiltersHref('/b', parseFilters(new URLSearchParams('range=7d&model=A&sort=count')))` → `/b/queries?range=7d`; with default range → `/b/queries`):

```ts
import { filtersToSearch, PAGE_SIZE, type QueryFilters } from './filters';

/** Keeps the time range, drops model/op/sort/limit. */
export function clearFiltersHref(base: string, f: QueryFilters): string {
  const qs = filtersToSearch({ range: f.range, models: [], ops: [], sort: 'wasted', limit: PAGE_SIZE });
  return `${base}/queries${qs ? `?${qs}` : ''}`;
}
```

`loading.tsx`: `PageHeader` skeleton + 8 skeleton rows (`Skeleton className="h-10 w-full"`).

- [ ] **Step 4: Run tests, typecheck, build**

Run: `pnpm --filter web test && pnpm --filter web exec tsc --noEmit && pnpm --filter web build` → PASS. Mutation: compute `wastedShare` from the raw string (`Number(r.totalMs)/…` is fine, but `r.totalMs / top` as string) — TypeScript should reject it; instead mutate `top > 0 ? … : 0` to drop the guard and confirm "all-zero totals" fails. Revert.

- [ ] **Step 5: Commit**

```bash
git add apps/web/components/dashboard apps/web/src/queries-view.ts apps/web/src/queries-view.test.ts "apps/web/app/dashboard/[org]/[app]/queries"
git commit -m "feat(web): queries table with range, filters and empty states"
```

---

### Task 8: Query detail — stats, charts, advice

**Files:**
- Create: `apps/web/components/dashboard/StatCard.tsx`, `HistogramChart.tsx`, `TrendChart.tsx`, `AdviceCard.tsx`, `apps/web/src/detail-view.ts`, `apps/web/app/dashboard/[org]/[app]/queries/[sig]/page.tsx`, `loading.tsx`, `apps/web/app/api/apps/[id]/advice/[adviceId]/route.ts`
- Test: `apps/web/src/detail-view.test.ts`, `apps/web/src/advice-route.test.ts`, `apps/web/components/dashboard/AdviceCard.test.tsx`

**Interfaces:**
- Consumes: `getQuery`, `getSeries` (Task 4); `parseRange`, `rangeToWindow`, `rangeToParams`; `histLabels`; `formatMs`, `formatCount`, `toMs`; `<Percentile>`; `<PageHeader>`, `<RangeControl>`; `rejectCrossSiteAuthPost`, `sessionOr401`, `safeUpstreamMessage`; `authedFetch`.
- Produces:
  - `createIndexCall(model: string, s: SuggestionField[]): string` → `Order.collection.createIndex({ email: 1, total: -1 })`
  - `histogramData(hist: number[]): { bucket: string; count: number }[]`
  - `trendData(points: SeriesPoint[], grain): { label: string; at: string; calls: number; p95: number | null }[]` (label `HH:00` hourly, `MMM d` daily; p95 value in ms or null)
  - `PATCH /api/apps/[id]/advice/[adviceId]` body `{status: 'APPLIED'|'DISMISSED'}` → 200 `{status}` | 400 | 403 | 404 | 502
  - `<AdviceCard appId advice model />` client component.

- [ ] **Step 1: Write the failing tests**

```ts
// apps/web/src/detail-view.test.ts
import { describe, it, expect } from 'vitest';
import { createIndexCall, histogramData, trendData } from './detail-view';

describe('createIndexCall', () => {
  it('keeps field order and direction', () =>
    expect(createIndexCall('Order', [{ field: 'email', dir: 1 }, { field: 'total', dir: -1 }]))
      .toBe('Order.collection.createIndex({ email: 1, total: -1 })'));
  it('quotes dotted or unusual field names', () =>
    expect(createIndexCall('User', [{ field: 'address.city', dir: 1 }])).toBe(`User.collection.createIndex({ "address.city": 1 })`));
});

describe('histogramData', () => {
  it('pairs counts with labels', () => {
    const d = histogramData([0, 3, 1, 0, 0, 0, 0, 2]);
    expect(d[1]).toEqual({ bucket: '100–250ms', count: 3 });
    expect(d[7]).toEqual({ bucket: '≥ 10s', count: 2 });
  });
});

describe('trendData', () => {
  it('hourly labels and p95 in ms (null when absent)', () => {
    const d = trendData([
      { at: '2026-10-18T09:00:00.000Z', count: 4, totalMs: '400', maxMs: 200, avgMs: 100, p95: { value: 180, basis: 'interpolated' } },
      { at: '2026-10-18T10:00:00.000Z', count: 0, totalMs: '0', maxMs: 0, avgMs: null, p95: null },
    ], 'hourly');
    expect(d[0]).toMatchObject({ label: '09:00', calls: 4, p95: 180 });
    expect(d[1]!.p95).toBeNull();
  });
  it('daily labels', () =>
    expect(trendData([{ at: '2026-10-18T00:00:00.000Z', count: 1, totalMs: '1', maxMs: 1, avgMs: 1, p95: null }], 'daily')[0]!.label).toBe('Oct 18'));
});
```

```ts
// apps/web/src/advice-route.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
vi.mock('@/src/auth', () => ({ getSession: vi.fn() }));
vi.mock('@/src/api', () => ({ apiOrigin: () => 'https://api.test', authedFetch: vi.fn() }));
import { getSession } from '@/src/auth';
import { authedFetch } from '@/src/api';
import { PATCH } from '@/app/api/apps/[id]/advice/[adviceId]/route';

const ORIGIN = 'https://app.test';
const ctx = { params: Promise.resolve({ id: 'a1', adviceId: 'ad1' }) };
const req = (body: unknown, origin = ORIGIN) => new Request(`${ORIGIN}/api/apps/a1/advice/ad1`, {
  method: 'PATCH', headers: { 'content-type': 'application/json', origin, host: 'app.test' }, body: JSON.stringify(body),
});

beforeEach(() => {
  process.env.WEB_ORIGIN = ORIGIN;
  vi.mocked(getSession).mockResolvedValue({ accessToken: 'tok', user: {} } as never);
  vi.mocked(authedFetch).mockReset();
});

describe('PATCH advice', () => {
  it('cross-site → 403, API untouched', async () => {
    expect((await PATCH(req({ status: 'APPLIED' }, 'https://evil.test'), ctx)).status).toBe(403);
    expect(authedFetch).not.toHaveBeenCalled();
  });
  it('rejects anything but APPLIED/DISMISSED (there is no way back to OPEN)', async () => {
    expect((await PATCH(req({ status: 'OPEN' }), ctx)).status).toBe(400);
  });
  it('forwards with the token server-side', async () => {
    vi.mocked(authedFetch).mockResolvedValue({ ok: true, data: { status: 'APPLIED' } });
    const res = await PATCH(req({ status: 'APPLIED' }), ctx);
    expect(res.status).toBe(200);
    expect(vi.mocked(authedFetch).mock.calls[0]![0]).toBe('/v1/apps/a1/advice/ad1');
    expect(vi.mocked(authedFetch).mock.calls[0]![1]).toBe('tok');
  });
  it('upstream 403 maps to a safe message', async () => {
    vi.mocked(authedFetch).mockResolvedValue({ ok: false, status: 403, error: 'role VIEWER' });
    const res = await PATCH(req({ status: 'DISMISSED' }), ctx);
    expect(res.status).toBe(403);
    expect(JSON.stringify(await res.json())).not.toContain('VIEWER');
  });
});
```

(`rejectCrossSiteAuthPost` is named for POST but checks method-agnostic headers; confirm it does not reject non-POST methods. If it does, rename-free: add an exported `rejectCrossSiteMutation` alias in `same-origin-guard.ts` that skips the method check, with a test, and use it here.)

```tsx
// @vitest-environment jsdom
// apps/web/components/dashboard/AdviceCard.test.tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { AdviceCard } from './AdviceCard';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

const advice = { id: 'ad1', suggestion: [{ field: 'email', dir: 1 as const }], rationale: 'Equality first.', status: 'OPEN' as const, updatedAt: '' };

describe('AdviceCard', () => {
  it('shows the createIndex call and rationale', () => {
    render(<AdviceCard appId="a1" model="Order" advice={advice} />);
    expect(screen.getByText('Order.collection.createIndex({ email: 1 })')).toBeTruthy();
    expect(screen.getByText('Equality first.')).toBeTruthy();
  });
  it('asks for confirmation before marking applied (no undo)', () => {
    render(<AdviceCard appId="a1" model="Order" advice={advice} />);
    fireEvent.click(screen.getByRole('button', { name: /mark as applied/i }));
    expect(screen.getByText(/can.t be undone/i)).toBeTruthy();
  });
  it('a settled advice shows its status and no action buttons', () => {
    render(<AdviceCard appId="a1" model="Order" advice={{ ...advice, status: 'DISMISSED' }} />);
    expect(screen.getByText(/dismissed/i)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /mark as applied/i })).toBeNull();
  });
  it('null advice explains why', () => {
    render(<AdviceCard appId="a1" model="Order" advice={null} />);
    expect(screen.getByText(/No index suggestion/)).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter web test src/detail-view.test.ts src/advice-route.test.ts components/dashboard/AdviceCard.test.tsx` → FAIL.

- [ ] **Step 3: Implement**

```ts
// apps/web/src/detail-view.ts
import type { SeriesPoint, SuggestionField } from './dashboard-types';
import { histLabels } from './hist';

const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

export function createIndexCall(model: string, s: SuggestionField[]): string {
  const fields = s.map(({ field, dir }) => `${IDENT.test(field) ? field : JSON.stringify(field)}: ${dir}`).join(', ');
  return `${model}.collection.createIndex({ ${fields} })`;
}

export function histogramData(hist: number[]): { bucket: string; count: number }[] {
  const labels = histLabels();
  return hist.map((count, i) => ({ bucket: labels[i] ?? `#${i}`, count }));
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function trendData(points: SeriesPoint[], grain: 'hourly' | 'daily') {
  return points.map((p) => {
    const d = new Date(p.at);
    const label = grain === 'hourly'
      ? `${String(d.getUTCHours()).padStart(2, '0')}:00`
      : `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
    return { label, at: p.at, calls: p.count, p95: p.p95 ? p.p95.value : null };
  });
}
```

```ts
// apps/web/app/api/apps/[id]/advice/[adviceId]/route.ts
import { NextResponse } from 'next/server';
import { authedFetch } from '@/src/api';
import { rejectCrossSiteAuthPost } from '@/src/same-origin-guard';
import { sessionOr401 } from '@/src/route-session';
import { safeUpstreamMessage } from '@/src/upstream-errors';

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string; adviceId: string }> },
): Promise<Response> {
  const rejected = rejectCrossSiteAuthPost(request);
  if (rejected) return rejected;
  const gate = await sessionOr401();
  if ('response' in gate) return gate.response;

  const body = (await request.json().catch(() => null)) as { status?: unknown } | null;
  if (body?.status !== 'APPLIED' && body?.status !== 'DISMISSED') {
    return NextResponse.json({ error: 'Invalid status.' }, { status: 400 });
  }
  const { id, adviceId } = await params;
  const res = await authedFetch(`/v1/apps/${encodeURIComponent(id)}/advice/${encodeURIComponent(adviceId)}`, gate.session.accessToken, {
    method: 'PATCH',
    body: JSON.stringify({ status: body.status }),
  });
  if (!res.ok) {
    const status = res.status === 404 ? 404 : res.status === 403 ? 403 : res.status >= 500 ? 502 : 400;
    return NextResponse.json({ error: safeUpstreamMessage(res.status, 'generic') }, { status });
  }
  return NextResponse.json({ status: body.status });
}
```

```tsx
// apps/web/components/dashboard/StatCard.tsx
import { Card, CardContent } from '@/components/ui/card';

export function StatCard({ label, children, hint }: { label: string; children: React.ReactNode; hint?: React.ReactNode }) {
  return (
    <Card>
      <CardContent className="flex flex-col gap-1 py-4">
        <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</span>
        <span className="text-2xl font-semibold tabular-nums">{children}</span>
        {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
      </CardContent>
    </Card>
  );
}
```

```tsx
// apps/web/components/dashboard/HistogramChart.tsx
'use client';
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from 'recharts';
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from '@/components/ui/chart';

const config = { count: { label: 'Calls', color: 'var(--chart-1)' } } satisfies ChartConfig;

export function HistogramChart({ data }: { data: { bucket: string; count: number }[] }) {
  return (
    <ChartContainer config={config} className="h-56 w-full">
      <BarChart data={data} margin={{ left: 0, right: 8 }}>
        <CartesianGrid vertical={false} />
        <XAxis dataKey="bucket" tickLine={false} axisLine={false} fontSize={11} interval={0} angle={-30} textAnchor="end" height={48} />
        <YAxis allowDecimals={false} tickLine={false} axisLine={false} width={32} fontSize={11} />
        <ChartTooltip content={<ChartTooltipContent />} />
        <Bar dataKey="count" fill="var(--color-count)" radius={4} />
      </BarChart>
    </ChartContainer>
  );
}
```

```tsx
// apps/web/components/dashboard/TrendChart.tsx
'use client';
import { CartesianGrid, Line, LineChart, XAxis, YAxis } from 'recharts';
import { ChartContainer, ChartLegend, ChartLegendContent, ChartTooltip, ChartTooltipContent, type ChartConfig } from '@/components/ui/chart';

const config = {
  calls: { label: 'Calls', color: 'var(--chart-2)' },
  p95: { label: 'p95 (ms)', color: 'var(--chart-1)' },
} satisfies ChartConfig;

export function TrendChart({ data }: { data: { label: string; calls: number; p95: number | null }[] }) {
  return (
    <ChartContainer config={config} className="h-56 w-full">
      <LineChart data={data} margin={{ left: 0, right: 8 }}>
        <CartesianGrid vertical={false} />
        <XAxis dataKey="label" tickLine={false} axisLine={false} fontSize={11} minTickGap={24} />
        <YAxis yAxisId="calls" allowDecimals={false} tickLine={false} axisLine={false} width={32} fontSize={11} />
        <YAxis yAxisId="p95" orientation="right" tickLine={false} axisLine={false} width={40} fontSize={11} />
        <ChartTooltip content={<ChartTooltipContent />} />
        <ChartLegend content={<ChartLegendContent />} />
        <Line yAxisId="calls" dataKey="calls" stroke="var(--color-calls)" strokeWidth={2} dot={false} />
        <Line yAxisId="p95" dataKey="p95" stroke="var(--color-p95)" strokeWidth={2} dot={false} connectNulls={false} />
      </LineChart>
    </ChartContainer>
  );
}
```

```tsx
// apps/web/components/dashboard/AdviceCard.tsx
'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Copy, Lightbulb, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import type { Advice } from '@/src/dashboard-types';
import { createIndexCall } from '@/src/detail-view';

type Target = 'APPLIED' | 'DISMISSED';

export function AdviceCard({ appId, model, advice }: { appId: string; model: string; advice: Advice | null }) {
  const router = useRouter();
  const [confirm, setConfirm] = useState<Target | null>(null);
  const [pending, setPending] = useState(false);
  const [status, setStatus] = useState(advice?.status ?? 'OPEN');

  if (!advice) {
    return (
      <Card>
        <CardHeader><CardTitle className="flex items-center gap-2 text-base"><Lightbulb className="size-4" /> Suggested index</CardTitle></CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          No index suggestion — this query already looks indexed or is too rare to judge.
        </CardContent>
      </Card>
    );
  }

  const call = createIndexCall(model, advice.suggestion);
  const submit = async (target: Target) => {
    setPending(true);
    try {
      const res = await fetch(`/api/apps/${encodeURIComponent(appId)}/advice/${encodeURIComponent(advice.id)}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status: target }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(body.error ?? 'Something went wrong. Please try again.');
      setStatus(target);
      toast.success(target === 'APPLIED' ? 'Marked as applied' : 'Suggestion dismissed');
      router.refresh();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setPending(false);
      setConfirm(null);
    }
  };

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-2">
        <CardTitle className="flex items-center gap-2 text-base"><Lightbulb className="size-4" /> Suggested index</CardTitle>
        {status !== 'OPEN' && <Badge variant="secondary">{status === 'APPLIED' ? 'Applied' : 'Dismissed'}</Badge>}
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="flex items-start gap-2">
          <pre className="flex-1 overflow-x-auto rounded-md border bg-muted p-3 font-mono text-sm"><code>{call}</code></pre>
          <Button variant="outline" size="icon" aria-label="Copy createIndex call"
            onClick={async () => { await navigator.clipboard.writeText(call); toast.success('Copied'); }}>
            <Copy className="size-4" />
          </Button>
        </div>
        <p className="text-sm text-muted-foreground">{advice.rationale}</p>
        {status === 'OPEN' && (
          <div className="flex gap-2">
            <Button size="sm" disabled={pending} onClick={() => setConfirm('APPLIED')}>
              {pending && <Loader2 className="size-4 animate-spin" />} Mark as applied
            </Button>
            <Button size="sm" variant="ghost" disabled={pending} onClick={() => setConfirm('DISMISSED')}>Dismiss</Button>
          </div>
        )}
      </CardContent>
      <AlertDialog open={confirm !== null} onOpenChange={(o) => !o && setConfirm(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{confirm === 'APPLIED' ? 'Mark this index as applied?' : 'Dismiss this suggestion?'}</AlertDialogTitle>
            <AlertDialogDescription>This can&apos;t be undone.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => confirm && submit(confirm)}>Confirm</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
```

```tsx
// apps/web/app/dashboard/[org]/[app]/queries/[sig]/page.tsx
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import { requireSession } from '@/src/auth';
import { getQuery, getSeries } from '@/src/dashboard-api';
import { parseRange, rangeToParams, rangeToWindow } from '@/src/range';
import { formatCount, formatMs } from '@/src/format';
import { histogramData, trendData } from '@/src/detail-view';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { PageHeader } from '@/components/dashboard/PageHeader';
import { RangeControl } from '@/components/dashboard/RangeControl';
import { Percentile } from '@/components/dashboard/Percentile';
import { StatCard } from '@/components/dashboard/StatCard';
import { HistogramChart } from '@/components/dashboard/HistogramChart';
import { TrendChart } from '@/components/dashboard/TrendChart';
import { AdviceCard } from '@/components/dashboard/AdviceCard';
import { CopyButton } from '@/app/_components/landing/CopyButton';

export default async function QueryDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ org: string; app: string; sig: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { org, app, sig } = await params;
  const range = parseRange(await searchParams);
  const rangeQs = new URLSearchParams(rangeToParams(range)).toString();
  const base = `/dashboard/${encodeURIComponent(org)}/${encodeURIComponent(app)}`;
  const self = `${base}/queries/${encodeURIComponent(sig)}${rangeQs ? `?${rangeQs}` : ''}`;
  const session = await requireSession(self);
  const w = rangeToWindow(range);

  const [detail, series] = await Promise.all([
    getQuery(session.accessToken, app, sig, w),
    getSeries(session.accessToken, app, sig, w),
  ]);
  if (!detail.ok) {
    if (detail.status === 404 || detail.status === 403) notFound();
    throw new Error('Could not load query');
  }
  const d = detail.data;

  return (
    <>
      <PageHeader
        title={`${d.model}.${d.operation}`}
        crumbs={[{ label: org }, { label: 'Queries', href: `${base}/queries${rangeQs ? `?${rangeQs}` : ''}` }, { label: `${d.model}.${d.operation}` }]}
        actions={<RangeControl value={range} />}
      />
      <div className="flex flex-col gap-6 p-6">
        <Link href={`${base}/queries${rangeQs ? `?${rangeQs}` : ''}`} className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="size-4" /> All queries
        </Link>
        <div className="flex items-start gap-2">
          <pre className="flex-1 overflow-x-auto rounded-lg border bg-muted p-4 font-mono text-sm"><code>{d.signature}</code></pre>
          <CopyButton text={d.signature} />
        </div>
        <p className="text-xs text-muted-foreground">First seen {new Date(d.firstSeen).toUTCString()} · last seen {new Date(d.lastSeen).toUTCString()}</p>

        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          <StatCard label="Calls">{formatCount(d.count)}</StatCard>
          <StatCard label="Time wasted">{formatMs(d.totalMs)}</StatCard>
          <StatCard label="p95" hint={<Percentile label="p99" value={d.p99} />}><Percentile label="p95" showLabel={false} value={d.p95} /></StatCard>
          <StatCard label="Max">{formatMs(d.maxMs)}</StatCard>
        </div>

        <div className="grid gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader><CardTitle className="text-base">Latency distribution</CardTitle></CardHeader>
            <CardContent><HistogramChart data={histogramData(d.hist)} /></CardContent>
          </Card>
          <Card>
            <CardHeader><CardTitle className="text-base">Trend</CardTitle></CardHeader>
            <CardContent>
              {series.ok && series.data.points.length > 0
                ? <TrendChart data={trendData(series.data.points, series.data.grain)} />
                : <p className="py-16 text-center text-sm text-muted-foreground">No trend data in this window.</p>}
            </CardContent>
          </Card>
        </div>

        <AdviceCard appId={app} model={d.model} advice={d.advice} />

        {d.redactedSample != null && (
          <Card>
            <CardHeader><CardTitle className="text-base">Redacted sample</CardTitle></CardHeader>
            <CardContent className="flex flex-col gap-2">
              <pre className="overflow-x-auto rounded-md border bg-muted p-3 font-mono text-xs"><code>{JSON.stringify(d.redactedSample, null, 2)}</code></pre>
              <p className="text-xs text-muted-foreground">Values are never sent — shapes only.</p>
            </CardContent>
          </Card>
        )}
      </div>
    </>
  );
}
```

Check `CopyButton`'s props in `app/_components/landing/CopyButton.tsx` (Plan B Task 6) and adapt; if it is landing-specific, move it to `components/dashboard/CopyButton.tsx` and update the landing import (fix its unmount timer leak — Plan B deferred minor — while moving: clear the timeout in a `useEffect` cleanup).

`loading.tsx`: header skeleton, 4 stat skeletons, two chart skeleton cards (`h-56`).

- [ ] **Step 4: Run tests, typecheck, build**

Run: `pnpm --filter web test && pnpm --filter web exec tsc --noEmit && pnpm --filter web build` → PASS. Mutations: drop the confirm dialog (call `submit` directly) → "asks for confirmation" fails; allow `OPEN` in the route → "rejects anything but" fails. Revert.

- [ ] **Step 5: Commit**

```bash
git add apps/web/components/dashboard apps/web/src/detail-view.ts apps/web/src/detail-view.test.ts apps/web/src/advice-route.test.ts "apps/web/app/dashboard/[org]/[app]/queries/[sig]" "apps/web/app/api/apps/[id]/advice" apps/web/app/_components
git commit -m "feat(web): query detail — stats, latency and trend charts, index advice"
```

---

### Task 9: Security pins and polish

**Files:**
- Create: `apps/web/src/client-bundle.test.ts`, `apps/web/components/dashboard/FadeIn.tsx` (or reuse landing's), `apps/web/components/dashboard/CountUp.tsx`
- Modify: queries and detail pages (wrap content in `FadeIn`; stat numbers in `CountUp` where the value is a plain number), `apps/web/.env.example` (no new vars expected — confirm)

**Interfaces:**
- Consumes: everything above.
- Produces: `<CountUp value={number} format={(n) => string} />` (client; renders final value immediately when reduced motion).

- [ ] **Step 1: Write the bundle pin test**

```ts
// apps/web/src/client-bundle.test.ts
import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const STATIC = path.resolve(__dirname, '../.next/static');

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = path.join(dir, f);
    return statSync(p).isDirectory() ? files(p) : [p];
  });
}

describe.skipIf(!existsSync(STATIC))('client bundle (run after `next build`)', () => {
  it('never references the session cookie or the API bearer header', () => {
    const offenders = files(STATIC)
      .filter((f) => f.endsWith('.js'))
      .filter((f) => /qa_session|authorization['"]?\s*[:,]\s*[`'"]Bearer/i.test(readFileSync(f, 'utf8')));
    expect(offenders).toEqual([]);
  });
  it('never references the ingest-key create endpoint directly (only via /api/onboarding/app)', () => {
    const offenders = files(STATIC)
      .filter((f) => f.endsWith('.js'))
      .filter((f) => /\/v1\/apps\/[^"'`]*\/keys/.test(readFileSync(f, 'utf8')));
    expect(offenders).toEqual([]);
  });
});
```

- [ ] **Step 2: Build, then run it**

Run: `pnpm --filter web build && pnpm --filter web test src/client-bundle.test.ts`
Expected: PASS (not skipped). Mutation: temporarily import `SESSION_COOKIE` into `InstallStep.tsx` and render it in a hidden span; rebuild; the first test must fail. Revert and rebuild.

- [ ] **Step 3: Motion polish**

```tsx
// apps/web/components/dashboard/CountUp.tsx
'use client';
import { useEffect, useState } from 'react';
import { animate, useReducedMotion } from 'framer-motion';

export function CountUp({ value, format }: { value: number; format: (n: number) => string }) {
  const reduce = useReducedMotion();
  const [shown, setShown] = useState(reduce ? value : 0);
  useEffect(() => {
    if (reduce) { setShown(value); return; }
    const c = animate(0, value, { duration: 0.6, ease: 'easeOut', onUpdate: (v) => setShown(v) });
    return () => c.stop();
  }, [value, reduce]);
  return <>{format(shown)}</>;
}
```

`format` must be a client-safe function: pass a string key instead if Server→Client function props are rejected by Next (they are): use `<CountUp value={d.count} kind="count" />` with `kind: 'count' | 'ms'` mapping to `formatCount` / `formatMs` inside the component. Use it for Calls and Max (numbers); leave Time wasted (`totalMs` string) and p95 (`<Percentile>`) static.

Wrap each page's content `div` in a `FadeIn` (reuse `app/_components/landing/FadeIn.tsx` if generic; it honours reduced motion).

- [ ] **Step 4: Full verification**

Run: `pnpm -w run test && pnpm --filter web exec tsc --noEmit && pnpm --filter web build && pnpm --filter web test src/client-bundle.test.ts`
Expected: all green; bundle test not skipped.

- [ ] **Step 5: Commit**

```bash
git add apps/web
git commit -m "feat(web): bundle security pins and dashboard motion polish"
```

---

## Self-Review notes (author)

- Spec coverage: visual language → T1; shell, switcher, routing, last-used cookie, not-found/error → T4, T5; onboarding 4 steps, key-once contract, poll, help panel, leave-confirm → T6; queries controls/table/empty/loading → T7; detail stats/charts/advice (no undo)/sample → T8; formatMs/Percentile contracts → T2, T3; errors table → T4–T8; testing list → each task + T9 pins; dependency pinning → Global Constraints + T1.
- Known judgment points left to implementers with explicit instructions: API field names (T4), `env` on app create (T6), verify-request auth mode (T6), row `p95` availability (T7), `CommandItem asChild` (T5), CSRF guard method handling (T8), CopyButton location (T8).
