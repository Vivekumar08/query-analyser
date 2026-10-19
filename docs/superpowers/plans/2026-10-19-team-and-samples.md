# Team Access, Real-Value Samples, Pagination and Pinned Sidebar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pin the sidebar, add real pagination, let admins invite teammates, and let teams reveal end-to-end-encrypted real query values for MongoDB Compass `explain`.

**Architecture:**
- One Web-Crypto ECIES module in `packages/contract`: the SDK encrypts with it and the browser decrypts with it.
- The API stores only ciphertext, plus a passphrase-wrapped private key.
- Pagination is offset-based with `hasMore`.
- Invites reuse the API's existing invite routes, which gain email and revoke.
- New web screens follow the Mist look and the BFF route-handler pattern.

**Tech Stack:** TypeScript, Web Crypto (`globalThis.crypto.subtle`, Node ≥ 20 and browsers), zod, Fastify + Prisma 7 (Postgres), Next 16, Vitest.

**Spec:** `docs/superpowers/specs/2026-10-19-team-and-samples-design.md`. Read it; it is binding.

## Global Constraints

- **Algorithms:** ECDH P-256 key pair. ECIES: an ephemeral P-256 key, then HKDF-SHA-256 with `info = "qa-sample-v1"` and an empty salt, giving an AES-256-GCM key with a 12-byte IV. Private key at rest: AES-256-GCM under a key from PBKDF2-SHA-256, **600 000** iterations, 16-byte random salt. Envelope versions are `v: 1`.
- **Size caps:** serialised sample ≤ **16 KiB** (16 384 bytes of UTF-8). Contract `encryptedSample`: `epk` ≤ 200, `iv` ≤ 32, `ct` ≤ 24 000 chars.
- **Opt-in:** an SDK without `sampleKey` sends byte-identical payloads to today's. An API app without `samplePublicKey` stores no `encryptedSample`.
- **Never stored or sent:** no passphrase, no plaintext sample and no unwrapped private key in any HTTP request, log line, cookie, storage or server-rendered prop.
- **Pagination:** `PAGE_SIZE = 25`. API `offset` integer 0–10 000. API `limit` max 200. Web `MAX_LIMIT` = 200.
- **Passphrase:** minimum 12 characters, confirmed twice on setup.
- **Dependencies:** none new.
- **Migrations:** additive and nullable, created with `prisma migrate dev --create-only` and committed.
- **Web:** Mist styling (glass, pills, `text-accent-text` for text, never `text-chart-1`). BFF handlers: `rejectCrossSiteAuthPost` (for mutations) → `sessionOr401` → `authedFetch` → `safeUpstreamMessage`, with `cache-control: no-store`.
- **Component tests:** first line `// @vitest-environment jsdom` and `afterEach(cleanup)`.
- **Commits:** conventional, no co-author trailers. Never push.
- **Test commands:**
  - `pnpm --filter @query-analyser/contract test`
  - `pnpm --filter @vivekumar08/query-analyser test` (sdk)
  - `pnpm --filter @query-analyser/api test` (needs Postgres via `DATABASE_URL` and `pnpm --filter @query-analyser/api db:generate`)
  - `pnpm --filter @query-analyser/web test`
  - Plus `tsc --noEmit` per package and `pnpm --filter @query-analyser/web build`.

## Review Focus

1. **A wrong passphrase, a corrupted envelope, or a key rotated after a sample was stored.** Expected: a clear error, no crash, nothing leaked. Pinned by the Task 4 tests "rejects wrong passphrase", "rejects tampered ciphertext" and "rejects envelope from another key", and by the Task 7 rotation test.
2. **Huge or exotic sample values** (ObjectId, Date, RegExp, Decimal128, Buffer, Map/Set, circular, >16 KiB). Expected: serialised faithfully or skipped, never a throw out of the SDK. Pinned by the Task 5 serializer tests.
3. **The last page boundary** (exactly 25 rows left; page beyond the end; `page=0` or garbage). Expected: Next disabled correctly, out-of-range pages show the empty state with "Back to page 1", garbage falls back to page 1. Pinned by the Task 2 and Task 3 tests.
4. **Invite edge cases** (expired, revoked, wrong email, already a member, inviter not ADMIN). Expected: specific messages, no generic 500. Pinned by the Task 9 and Task 10 tests.
5. **Plaintext or passphrase leaking to the server.** Expected: never. Pinned by the Task 8 test that asserts the reveal flow's network calls carry no passphrase or plaintext, and by the Task 6 test that the ingest API drops `encryptedSample` for apps without a key.

---

## File Structure

| Path | Responsibility |
|---|---|
| `apps/web/components/dashboard/Sidebar.tsx`, `app/dashboard/[org]/[app]/layout.tsx` | pinned sidebar |
| `apps/api/src/analysis/routes.ts` | `offset`, tiebreaker, `hasMore` |
| `apps/web/src/filters.ts`, `src/queries-view.ts`, `components/dashboard/Pagination.tsx`, `app/dashboard/[org]/[app]/queries/page.tsx` | page param and controls |
| `packages/contract/src/sample-crypto.ts` (+ export from `./runtime`) | key gen, wrap/unwrap, ECIES encrypt/decrypt, base64 helpers |
| `packages/contract/src/schema.ts`, `runtime.ts` | `encryptedSample` on ingest item |
| `packages/sdk/src/ejson.ts`, `aggregator.ts`, `hooks.ts`, `index.ts`, `types.ts` | raw sample capture, serialise, encrypt at flush |
| `apps/api/prisma/schema.prisma` + migration, `src/ingest/writer.ts`, `src/apps/sample-key.ts`, `src/analysis/routes.ts` | storage + sample-key routes + detail field |
| `apps/web/app/dashboard/[org]/[app]/settings/page.tsx`, `components/settings/*`, `app/api/apps/[id]/sample-key/route.ts` | Settings page: sample-key section |
| `apps/web/src/compass.ts`, `components/dashboard/CompassQuery.tsx`, `components/dashboard/RevealValues.tsx` | Compass command and reveal |
| `apps/api/src/orgs/invites.ts` | invite email + revoke |
| `apps/web/components/settings/Members.tsx`, `app/api/orgs/[org]/invites/**`, `app/api/orgs/[org]/members/**`, `app/invite/page.tsx`, `app/_components/AcceptInviteClient.tsx`, `app/api/invites/accept/route.ts`, `proxy.ts` | members and invites UI |
| `apps/web/next.config.ts`, `app/page.tsx` | security headers, homepage privacy copy |

---

### Task 1: Pinned sidebar

**Files:** Modify `apps/web/components/dashboard/Sidebar.tsx` and `apps/web/app/dashboard/[org]/[app]/layout.tsx`. Test: `components/dashboard/Sidebar.test.tsx` (extend).

**Interfaces:** Produces the same `Sidebar` props. The `aside` gets `sticky top-0 h-dvh`, and its nav region gets `overflow-y-auto`.

- [ ] **Step 1:** Write the failing test "sidebar is pinned": the rendered `aside` class contains `sticky`, `top-0` and `h-dvh`, and the element wrapping `nav` contains `overflow-y-auto`.
- [ ] **Step 2:** Run `pnpm --filter @query-analyser/web test components/dashboard/Sidebar.test.tsx`. Expect FAIL.
- [ ] **Step 3:** Implement. The layout's outer flex row stays `min-h-screen`. The main column must not set `overflow-hidden` (that would break sticky).
- [ ] **Step 4:** Tests and tsc pass.
- [ ] **Step 5:** Commit `fix(web): pin the dashboard sidebar`.

---

### Task 2: API offset pagination

**Files:** Modify `apps/api/src/analysis/routes.ts` (list query schema, `queryHourlyRanking` / `queryDailyRanking`, response). Test: extend the existing analysis routes test file (find it with `grep -rl "/queries" apps/api/src --include=*.test.ts`).

**Interfaces:** Produces `GET /v1/apps/:id/queries?offset=N`, whose response adds `offset: number` and `hasMore: boolean`. Ordering is `rank_key DESC, s.id ASC`. The query fetches `limit + 1` rows and returns at most `limit`.

- [ ] **Step 1:** Write the failing tests, seeding 7 signatures:
  - `limit=3&offset=0` gives 3 items with `hasMore: true`;
  - `offset=3` gives the next 3 with no overlap;
  - `offset=6` gives 1 item with `hasMore: false`;
  - `offset=50` gives 0 items with `hasMore: false`;
  - `offset=-1`, `offset=10001` and `offset=abc` give 400;
  - with no offset, the response has `offset: 0`;
  - two signatures with equal `rank_key` always come in the same order across calls.
- [ ] **Step 2:** Run (the API needs Postgres; see Global Constraints). Expect FAIL.
- [ ] **Step 3:** Implement, using SQL `OFFSET` with the tiebreaker inside the ranking CTE.
- [ ] **Step 4:** Run the API suite and `pnpm --filter @query-analyser/api typecheck`. Expect PASS.
- [ ] **Step 5:** Commit `feat(api): offset pagination with hasMore on the queries list`.

---

### Task 3: Web pagination

**Files:**
- Modify: `apps/web/src/filters.ts`, `src/queries-view.ts`, `src/dashboard-types.ts`, `app/dashboard/[org]/[app]/queries/page.tsx`.
- Create: `components/dashboard/Pagination.tsx`.
- Test: extend `src/filters.test.ts` and `src/queries-view.test.ts`; add `components/dashboard/Pagination.test.tsx`.

**Interfaces:**
- Consumes the Task 2 response fields `offset` and `hasMore`.
- Produces:
  - `QueryFilters` gains `page: number`; `limit` is removed from URL state. `PAGE_SIZE` = 25 and `MAX_LIMIT` = 200.
  - `parseFilters` reads `page` (an integer ≥ 1; anything else gives 1).
  - `filtersToSearch` omits `page=1`.
  - `filtersToApiQuery` sends `limit=25&offset=(page-1)*25`.
  - Changing range, model, op or sort drops `page`.
  - `<Pagination page hasMore hrefFor={(p) => string} />` renders Previous, "Page N" and Next as links, disabled when not applicable.
- `showMore` and the "top 500" code are deleted, along with their tests.

- [ ] **Step 1:** Write the failing tests:
  - `parseFilters({page:'3'}).page === 3`, and `'0'`, `'-2'`, `'x'` and absent all give 1;
  - `filtersToApiQuery` with page 3 contains `offset=50` and `limit=25`;
  - round trip omits `page=1`;
  - Pagination: page 1 has Previous disabled (`aria-disabled="true"`, not a link); `hasMore=false` disables Next; links come from `hrefFor`;
  - the dropdown-options call uses `limit=200`.
- [ ] **Step 2:** Run and confirm FAIL.
- [ ] **Step 3:** Implement. On an empty page beyond the end (page > 1 with 0 rows), show "No more queries" with a "Back to page 1" link.
- [ ] **Step 4:** Run the web suite, tsc and build.
- [ ] **Step 5:** Commit `feat(web): paginate the queries table`.

---

### Task 4: Shared sample crypto (contract)

**Files:** Create `packages/contract/src/sample-crypto.ts`; export it from `src/runtime.ts` and `src/index.ts`. Test: `packages/contract/src/sample-crypto.test.ts`.

**Interfaces:**
- Produces (all async, Web Crypto only, base64 = standard base64):
  - `generateSampleKeyPair(): Promise<{ publicKey: string /* SPKI b64 */; privateKey: CryptoKey }>` (private extractable for wrapping)
  - `wrapPrivateKey(privateKey: CryptoKey, passphrase: string, iterations = 600_000): Promise<WrappedKey>` where `WrappedKey = { v: 1; salt: string; iv: string; iterations: number; ciphertext: string }`
  - `unwrapPrivateKey(wrapped: WrappedKey, passphrase: string): Promise<CryptoKey>` throws `SampleKeyError('wrong-passphrase')` on GCM failure
  - `encryptSample(publicKeySpkiB64: string, plaintext: string): Promise<EncryptedSample>` where `EncryptedSample = { v: 1; epk: string /* raw P-256 public, b64 */; iv: string; ct: string }`
  - `decryptSample(privateKey: CryptoKey, env: EncryptedSample): Promise<string>` throws `SampleKeyError('undecryptable')`
  - `importSamplePublicKey(spkiB64: string): Promise<CryptoKey>` throws `SampleKeyError('invalid-public-key')`
  - `class SampleKeyError extends Error { code: 'wrong-passphrase' | 'undecryptable' | 'invalid-public-key' }`

- [ ] **Step 1:** Write the failing tests (lower the iterations to 1 000 in tests through the parameter, for speed):
  - **round trip:** generate, wrap, unwrap with the right passphrase, then encrypt and decrypt `{"filter":{"email":"a@b.c"}}` exactly;
  - **rejects wrong passphrase:** throws code `wrong-passphrase`;
  - **rejects tampered ciphertext:** flipping one char in `ct` throws `undecryptable`;
  - **rejects envelope from another key:** decrypting with a second key pair throws `undecryptable`;
  - **fresh ephemeral key:** two encryptions of the same plaintext differ in `epk`, `iv` and `ct`;
  - **output sizes:** `epk` ≤ 200 and `iv` ≤ 32 chars;
  - **invalid key:** `importSamplePublicKey('nope')` throws `invalid-public-key`;
  - **default iterations:** the wrap default is exactly 600 000 (assert `wrapped.iterations` when called without the argument, against a tiny key; allow ≤ 5s).
- [ ] **Step 2:** Run and confirm FAIL.
- [ ] **Step 3:** Implement with `crypto.subtle` (`ECDH`, `deriveBits` 256 → `HKDF` import → `deriveKey` AES-GCM; PBKDF2 → AES-GCM wrap of pkcs8). Do not import `node:crypto`.
- [ ] **Step 4:** Run the contract tests and typecheck.
- [ ] **Step 5:** Commit `feat(contract): shared end-to-end sample crypto`.

---

### Task 5: SDK encrypts real samples (opt-in)

**Files:**
- Modify: `packages/contract/src/schema.ts` and `runtime.ts` (`encryptedSample` optional, nullable, with the size caps), `packages/sdk/src/types.ts`, `aggregator.ts`, `hooks.ts`, `index.ts`.
- Create: `packages/sdk/src/ejson.ts`.
- Test: `packages/sdk/src/ejson.test.ts`, extend `aggregator.test.ts` and `index.test.ts` (or the closest existing init/flush test), and update `packages/contract/src/sdk-types-equality.test.ts`.

**Interfaces:**
- Consumes `encryptSample`, `importSamplePublicKey` and `SampleKeyError` (Task 4).
- Produces:
  - `InitOptions.sampleKey?: string`;
  - `serializeSample(value: unknown, maxBytes = 16_384): string | null` (`null` when over the cap);
  - aggregator items keep `rawSample` (the slowest occurrence; never sent);
  - payload items carry `encryptedSample?: EncryptedSample | null` **only when** `sampleKey` is set.

- [ ] **Step 1:** Write the failing tests:
  - **serializer types:** ObjectId gives `{"$oid":…}`, Date gives `{"$date":ISO}`, RegExp gives `{"$regex","$options"}`, Decimal128 gives `{"$numberDecimal"}`, Buffer gives `{"$binary":{"base64"}}`, Map/Set become arrays, a circular reference becomes `"<circular>"`;
  - **serializer cap:** over 16 KiB returns `null`;
  - **no key, same payload:** without `sampleKey` the flushed payload JSON has no `encryptedSample` key at all;
  - **with a key:** `encryptedSample` decrypts (using the test's private key) to the slowest call's real filter;
  - **failure path:** an encryption failure calls `onError` once and still sends the batch with `encryptedSample: null`;
  - **bad key at init:** an invalid `sampleKey` reports `onError` once and runs without encryption;
  - **contract:** rejects a `ct` over 24 000 chars and accepts a missing `encryptedSample`.
- [ ] **Step 2:** Run and confirm FAIL.
- [ ] **Step 3:** Implement. Keep the hook synchronous by capturing the raw input there; encrypt asynchronously in the flush path before transport.
- [ ] **Step 4:** Run the SDK and contract suites and typechecks. The SDK build (`pnpm --filter @vivekumar08/query-analyser build`) must succeed with zero runtime deps.
- [ ] **Step 5:** Commit `feat(sdk): opt-in end-to-end encrypted real-value samples`.

---

### Task 6: API stores keys and ciphertext

**Files:**
- Modify: `apps/api/prisma/schema.prisma`, `src/ingest/writer.ts`, `src/analysis/routes.ts` (detail adds `encryptedSample`), `src/apps/routes.ts` (register).
- Create: `prisma/migrations/<timestamp>_sample_encryption/migration.sql` and `src/apps/sample-key.ts`.
- Test: `src/apps/__tests__/sample-key.test.ts` (or the colocated pattern used by app routes), and extend the ingest writer/route tests and the detail route test.

**Interfaces:**
- Produces:
  - Prisma: `App.samplePublicKey String?`, `App.sampleKeyWrapped Json?`, `QuerySignature.encryptedSample Json?`.
  - `GET /v1/apps/:id/sample-key` (VIEWER) returns `{ enabled: boolean, publicKey?: string, wrapped?: WrappedKey }`.
  - `PUT /v1/apps/:id/sample-key` (ADMIN) takes `{ publicKey, wrapped }` (zod-validated: `publicKey` base64 ≤ 300, `wrapped.v === 1`, `iterations ≥ 600000`, field lengths bounded). It validates that the public key imports as P-256 (`importSamplePublicKey`), sets the key, and **nulls `encryptedSample` on all of the app's signatures**. Returns 200 `{ enabled: true, publicKey }`.
  - `DELETE` (ADMIN) clears both App fields and all `encryptedSample`. Returns 204.
  - Detail response gains `encryptedSample: EncryptedSample | null`.

- [ ] **Step 1:** Write the failing tests:
  - **ingest stores ciphertext:** for an app with a key, `encryptedSample` is stored and returned by the detail route;
  - **ingest drops it for apps without a key:** for an app without a key it is NOT stored (null in the DB);
  - **COALESCE:** a later batch without `encryptedSample` keeps the stored one;
  - **PUT rules:** PUT by MEMBER gives 403; PUT with a non-P-256 key gives 400; PUT with `iterations` 1000 gives 400;
  - **rotate clears:** PUT on rotation clears previously stored `encryptedSample`;
  - **GET:** works for VIEWER; with no key it returns `{ enabled: false }`;
  - **DELETE:** clears.
- [ ] **Step 2:** Create the migration with `pnpm --filter @query-analyser/api exec prisma migrate dev --create-only --name sample_encryption`. Review the SQL: it must be additive and nullable only. Run `db:generate`, then run the tests and confirm FAIL.
- [ ] **Step 3:** Implement. Extend the writer's raw SQL `jsonb_to_recordset` column list and the COALESCE.
- [ ] **Step 4:** Run the API suite and typecheck.
- [ ] **Step 5:** Commit `feat(api): store sample keys and encrypted samples`.

---

### Task 7: Settings page — real-value samples

**Files:**
- Create:
  - `apps/web/app/dashboard/[org]/[app]/settings/page.tsx`
  - `components/settings/SampleKeySection.tsx` (client)
  - `app/api/apps/[id]/sample-key/route.ts` (GET, PUT, DELETE)
  - `src/passphrase.ts` (pure: `passphraseIssue(p, confirm) → string | null`)
- Modify: `components/dashboard/Sidebar.tsx` ("Settings" becomes a link; Overview and Alerts stay "Soon"), `src/dashboard-api.ts` (`getSampleKey`).
- Test: `src/passphrase.test.ts`, `src/sample-key-route.test.ts`, `components/settings/SampleKeySection.test.tsx`.

**Interfaces:**
- Consumes `generateSampleKeyPair` and `wrapPrivateKey` (Task 4); the API routes (Task 6); `getShellContext`.
- Produces the settings page at `…/settings` with section anchors `#members` (Task 10) and `#samples`.

- [ ] **Step 1:** Write the failing tests:
  - **passphrase rules:** under 12 chars gives an issue; a mismatch gives an issue; a good pair gives null;
  - **BFF route:** PUT without the CSRF guard gives 403; it forwards only `{publicKey, wrapped}` (the request-body assertion has no `passphrase` and no `privateKey` key); upstream 403 maps to "Only workspace admins can change this.";
  - **GET:** for VIEWER passes through with no-store;
  - **component:** "Enable" with a valid passphrase calls PUT with a body whose JSON has no `passphrase` substring, then shows `QA_SAMPLE_KEY=` with Copy;
  - **rotate warning:** "Rotate" shows a confirm warning that stored values will be cleared;
  - **non-admin:** sees status only, no buttons.
- [ ] **Step 2:** Run and confirm FAIL.
- [ ] **Step 3:** Implement, in Mist styling.
- [ ] **Step 4:** Run the web suite, tsc and build.
- [ ] **Step 5:** Commit `feat(web): settings to enable end-to-end encrypted samples`.

---

### Task 8: Query for Compass and Reveal values

**Files:**
- Create: `apps/web/src/compass.ts`, `components/dashboard/CompassQuery.tsx` (client), `components/dashboard/RevealValues.tsx` (client).
- Modify: `app/dashboard/[org]/[app]/queries/[sig]/page.tsx` (replace the Redacted sample card), `src/dashboard-types.ts` (`encryptedSample`).
- Test: `src/compass.test.ts`, `components/dashboard/RevealValues.test.tsx`.

**Interfaces:**
- Consumes `unwrapPrivateKey`, `decryptSample` and `SampleKeyError` (Task 4); the BFF GET sample-key (Task 7).
- Produces:
  - `defaultCollection(model: string): string`: lowercase and pluralise. Rules: a trailing `y` after a consonant becomes `ies`; `s`, `x`, `z`, `ch` or `sh` takes `es`; otherwise add `s`. `Order` gives `orders`, `Category` gives `categories`, `Box` gives `boxes`, `Address` gives `addresses`.
  - `placeholderize(redacted: unknown): string` replaces type tokens with readable placeholders. `"<string>"` under key `email` becomes `<email>`; otherwise the type name, e.g. `<string>` or `<number>`. Output is valid mongosh syntax with the placeholders unquoted, inside angle brackets.
  - `compassCommand(collection, sample: {filter?, sort?, update?, pipeline?}, opts: {placeholder: boolean}): string` gives `db.getCollection("orders").find(<filter>).sort(<sort>).explain("executionStats")`, or `….aggregate(<pipeline>).explain("executionStats")`.
  - `<CompassQuery model redactedSample />` and `<RevealValues appId encryptedSample />`.

- [ ] **Step 1:** Write the failing tests:
  - `defaultCollection` cases as listed;
  - `compassCommand` for find + sort, find with no sort (no `.sort`), and aggregate;
  - the placeholder output contains `<email>`;
  - the real output from a decrypted EJSON sample renders `ObjectId("…")`, `ISODate("…")` and `/re/i`;
  - **reveal success:** fetch is mocked to return the wrapped key, and a correct passphrase shows the real command and a Copy button;
  - **wrong passphrase:** shows "That passphrase didn't unlock the key." and no values;
  - **no leak (Review Focus 5):** every mocked `fetch` call's URL and body contain neither the passphrase nor any plaintext value;
  - **Hide:** removes the values from the DOM.
- [ ] **Step 2:** Run and confirm FAIL.
- [ ] **Step 3:** Implement. Decrypted text lives in React state only; there is no `console` logging.
- [ ] **Step 4:** Run the web suite, tsc and build.
- [ ] **Step 5:** Commit `feat(web): query for Compass with end-to-end encrypted reveal`.

---

### Task 9: API invite email and revoke

**Files:** Modify `apps/api/src/orgs/invites.ts`. Test: extend the invites test file.

**Interfaces:**
- Produces:
  - `POST /v1/orgs/:org/invites` sends mail `{ to: email, subject: "You're invited to <org name> on Query Analyser", text and html containing ${WEB_ORIGIN}/invite?token=<token> }`. The response is unchanged.
  - `DELETE /v1/orgs/:org/invites/:id` (ADMIN) gives 204 for a pending invite in this org, and 404 otherwise (other org, accepted, expired).

- [ ] **Step 1:** Write the failing tests:
  - invite creation puts one mail in `app.sentMail` with the link containing the returned token;
  - the mail failing (mailer stub) still returns 201;
  - revoke 204, after which accepting gives 410 or 404 (whichever the accept route returns for a missing invite; assert the actual code and document it);
  - revoke from another org's admin gives 404;
  - revoke by MEMBER gives 403.
- [ ] **Step 2:** Run and confirm FAIL.
- [ ] **Step 3:** Implement. The token is never logged.
- [ ] **Step 4:** Run the API suite and typecheck.
- [ ] **Step 5:** Commit `feat(api): email invites and let admins revoke them`.

---

### Task 10: Members and invites UI, accept page

**Files:**
- Create:
  - `apps/web/components/settings/Members.tsx` (client)
  - BFF routes `app/api/orgs/[org]/invites/route.ts` (GET, POST), `app/api/orgs/[org]/invites/[id]/route.ts` (DELETE), `app/api/orgs/[org]/members/[id]/route.ts` (PATCH, DELETE), `app/api/invites/accept/route.ts` (POST)
  - `app/invite/page.tsx`, `app/_components/AcceptInviteClient.tsx`
- Modify: `app/dashboard/[org]/[app]/settings/page.tsx` (mount Members; org id from the shell context), `src/dashboard-api.ts` (members and invites readers).
- Test: `src/invite-routes.test.ts`, `components/settings/Members.test.tsx`, `app/_components/AcceptInviteClient.test.tsx` (place it under `src/` if Vitest's include requires it).

**Interfaces:**
- Consumes the API org routes (existing plus Task 9) and `getShellContext` (org id from the slug).
- Produces the Members section and the `/invite?token=` flow.

- [ ] **Step 1:** Write the failing tests:
  - **BFF:** every mutation route returns 403 on a cross-site request; POST invite forwards `{email, role}` and returns `{inviteLink}` (`${origin}/invite?token=…`, built server-side from `WEB_ORIGIN`); upstream 403 "only an owner can invite an owner" maps to a safe message; accept maps 410 to "This invite has expired or was already used.", 403 to "This invite was sent to a different email address." and 409 to "You're already a member.";
  - **Members:** ADMIN sees the invite form, pending list and Revoke; OWNER additionally sees a role select and Remove with confirm; MEMBER sees "Ask an admin to invite teammates.";
  - **AcceptInviteClient:** scrubs `?token=` with `history.replaceState`, POSTs it once, and on success navigates to `/dashboard`;
  - **proxy:** `/invite` still requires a session; the redirect keeps `next=/invite?token=…` (assert with the existing proxy test helpers).
- [ ] **Step 2:** Run and confirm FAIL.
- [ ] **Step 3:** Implement in Mist styling.
- [ ] **Step 4:** Run the web suite, tsc and build.
- [ ] **Step 5:** Commit `feat(web): invite teammates and accept invites`.

---

### Task 11: Security headers and privacy copy

**Files:** Modify `apps/web/next.config.ts` and `app/page.tsx` (privacy section copy and heading). Test: `src/security-headers.test.ts`; update `src/homepage.test.tsx`.

**Interfaces:** Produces `headers()` returning the spec's CSP, `X-Content-Type-Options`, `Referrer-Policy` and `Permissions-Policy` for `/:path*`.

- [ ] **Step 1:** Write the failing tests:
  - import the config and call `headers()`; assert each header and the exact CSP directives from the spec (`frame-ancestors 'none'`, `object-src 'none'`, `connect-src 'self'`);
  - the homepage heading becomes "Shapes by default. *Values only if you hold the key.*" and the section mentions end-to-end encryption.
- [ ] **Step 2:** Run and confirm FAIL.
- [ ] **Step 3:** Implement. Verify the built app still loads `/`, `/login` and a dashboard route without CSP console errors: run `next start`, open each page with the Chrome DevTools MCP and check the console.
- [ ] **Step 4:** Run the web suite, tsc and build, plus the client-bundle test after the build.
- [ ] **Step 5:** Commit `feat(web): security headers and opt-in encryption copy`.
