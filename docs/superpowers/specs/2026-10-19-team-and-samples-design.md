# Team access, real-value samples, pagination and a pinned sidebar

Date: 2026-10-19
Repo: `query-analyser`: `packages/contract`, `packages/sdk`, `apps/api`, `apps/web`.
Builds on: Dashboard C1 and Mist (`feat/mist-design`).

## Why

User feedback after the Mist redesign:
1. **Sidebar.** It scrolls away with the page. It should stay pinned.
2. **Pagination.** The queries table should have real pagination instead of "Show more".
3. **Teammates.** Teammates should be able to analyse the same queries.
4. **Real queries.** Developers want the *exact* query, so they can paste it into MongoDB Compass and run `explain`.

Point 4 collides with the product's promise "shapes, never values". The user chose **end-to-end
encryption**:
- real values leave the customer's server encrypted with the customer's key;
- this service stores only ciphertext and cannot read it;
- the dashboard shows placeholders by default and decrypts in the browser on request.

## Decisions

| Topic | Decision |
|---|---|
| Who can decrypt | **One passphrase per app, shared by the team** (controller's call; the user said "implement all" without choosing). Per-person access is a later option. |
| Opt-in | Per app. With no key configured, the SDK behaves exactly as today. |
| Where crypto lives | One implementation in `packages/contract` (runtime-safe, Web Crypto only; `globalThis.crypto.subtle` exists in Node ≥ 20 and in browsers), used by the SDK to encrypt and by the dashboard to decrypt. No new dependencies. |
| Algorithms | App key pair: **ECDH P-256**. Sample encryption: ECIES — an ephemeral ECDH P-256 key, then HKDF-SHA-256 (`info = "qa-sample-v1"`), then **AES-256-GCM**. Private key at rest: wrapped with **AES-256-GCM** under a key from **PBKDF2-SHA-256, 600 000 iterations, 16-byte random salt**. |
| Pagination | Offset pagination: 25 per page. The API gains `offset` and `hasMore` with a stable tiebreaker. |
| Invites | Settings page: members list, invite by email + role, pending invites with revoke. The API emails the invite link. `/invite?token=` accept page. |
| Settings nav | "Settings" becomes a real link. Overview and Alerts stay "Soon". |

## 1. Pinned sidebar

The desktop sidebar is `sticky top-0 h-dvh` with its nav area scrolling on its own. The main column scrolls
independently. The mobile sheet is unchanged.

## 2. Pagination

- **API** `GET /v1/apps/:id/queries`:
  - new optional `offset` (integer 0–10 000, default 0);
  - ordering gains a stable tiebreaker (`rank_key DESC, signature id`);
  - the route fetches `limit + 1` rows and returns `hasMore: boolean` plus the `offset`;
  - `limit` max stays 200;
  - existing callers without `offset` behave as before, apart from the extra fields.
- **Web:**
  - URL param `page` (1-based, default 1), 25 per page, `offset = (page − 1) × 25`;
  - controls: "Previous", "Page N", "Next" (Next disabled when `!hasMore`, Previous disabled on page 1);
  - changing filters, sort or range resets to page 1;
  - the "Show more"/"top 500" logic is removed;
  - the web's `MAX_LIMIT` bug (500 vs the API's 200) goes away, and the dropdown-options call uses `limit=200`.

## 3. Teammates (invites)

- **API:**
  - `POST /v1/orgs/:org/invites` additionally **emails** the invitee a link `${WEB_ORIGIN}/invite?token=<token>` via the existing mailer. The response still carries the token, so the admin can copy the link as a fallback.
  - New `DELETE /v1/orgs/:org/invites/:id` (ADMIN) revokes a pending invite: 204, or 404 if it isn't pending in this org.
  - Existing rules are unchanged: only an OWNER invites an OWNER; members and role changes need OWNER; listing members needs ADMIN.
- **Web:**
  - `/dashboard/[org]/[app]/settings` page with sections "Members" (org) and "Real-value samples" (app).
  - **Members** shows:
    - the members list with name, email and role;
    - the invite form (email + role select) and the pending invites list with Revoke;
    - for OWNERs, role change and remove, with confirmation.
  - Members below ADMIN see the member list only if the API allows it. Otherwise they see "Ask an admin to invite teammates."
  - BFF route handlers follow the existing pattern: `rejectCrossSiteAuthPost` → `sessionOr401` → `authedFetch` → `safeUpstreamMessage`, with `no-store`.
  - `/invite?token=` page:
    - session-gated (a signed-out visitor goes through login and comes back);
    - scrubs the token from the URL after mount, like `/verify`;
    - accepts via BFF, then sends the user to `/dashboard`;
    - shows clear messages for expired or used invites (410), the wrong email (403) and already being a member (409);
    - keeps a new invitee on the invite: /login "Create one" carries `next` (through `safeNext`) to /signup and on after signup. Because the verify link opens in a new tab, the page also stores `{path, savedAt}` under localStorage `qa:pendingInvite` (7-day expiry; cleared on accept and on 404/410/409/wrong-email 403, kept while the email is unverified), and /verify success and onboarding offer "Continue to your invite".

## 4. Real-value samples (end-to-end encrypted)

### Key setup (Settings → "Real-value samples", ADMIN+)

1. **"Enable"** asks for a passphrase. Minimum 12 characters, typed twice, with a strength hint and a warning: "If you lose this passphrase, stored values cannot be recovered."
2. The browser generates an ECDH P-256 key pair and wraps the private key under the passphrase. It sends **only** `{ publicKey (SPKI, base64), wrapped: { v: 1, salt, iv, iterations, ciphertext } }` to `PUT /v1/apps/:id/sample-key`.
3. The page shows the public key as an env line to paste: `QA_SAMPLE_KEY=<base64>`, with copy.
4. **"Rotate"**:
   - generates a new pair (passphrase asked again);
   - replaces the stored key;
   - **clears all stored encrypted samples for the app** (old ciphertext is unreadable with the new key);
   - shows the new env line.
5. **"Disable"** removes the key and clears encrypted samples.

### SDK

- New `InitOptions.sampleKey?: string` (the base64 SPKI public key). Typically `process.env.QA_SAMPLE_KEY`.
- When set:
  - the aggregator keeps, alongside the redacted sample, the **raw sample input** of the slowest occurrence (same "slowest wins" rule);
  - at flush, the raw sample is serialised to Extended-JSON-like text (ObjectId → `{"$oid"}`, Date → `{"$date"}`, RegExp → `{"$regex","$options"}`, Decimal128 → `{"$numberDecimal"}`, Buffer/Binary → `{"$binary"}`, Map/Set → arrays; circular → `"<circular>"`);
  - serialisation is capped at **16 KiB**; over the cap the sample is skipped (no encrypted sample, redacted still sent);
  - the serialised text is encrypted, and `item.encryptedSample = { v: 1, epk, iv, ct }` (base64 strings) is attached.
- Encryption failures never throw out of the SDK. They go to `onError`, and the batch is still sent without `encryptedSample`.
- An invalid `sampleKey` is detected at `init()`. The SDK reports it via `onError` once and runs without encryption.

### Contract and API

- **Contract:** the ingest item gets an optional `encryptedSample` (`{ v: 1, epk ≤ 200, iv ≤ 32, ct ≤ 24 000 }` chars, nullable). The SDK/contract type-equality test is updated.
- **Prisma migration:**
  - `App.samplePublicKey String?`
  - `App.sampleKeyWrapped Json?`
  - `QuerySignature.encryptedSample Json?`
- **Ingest:** stores `encryptedSample` with the same COALESCE rule as `redactedSample`. If the app has **no** `samplePublicKey`, it ignores `encryptedSample` (it doesn't store it).
- **Routes:**
  - `GET /v1/apps/:id/sample-key` (VIEWER) returns `{ enabled, publicKey?, wrapped? }`. The wrapped key is only useful with the passphrase.
  - `PUT` (ADMIN) sets or rotates the key and clears encrypted samples.
  - `DELETE` (ADMIN) disables it and clears them.
- **Detail endpoint:** adds `encryptedSample`. The list endpoint does not.

### Dashboard (query detail)

- **"Query for Compass" card**, replacing the "Redacted sample" card:
  - built from `redactedSample`: type tokens become readable placeholders (`"<string>"` → `<email>`-style hints from the key name, falling back to the type);
  - shows a ready-to-paste command `db.getCollection("<collection>").find(<filter>).sort(<sort>).explain("executionStats")` (or `.aggregate(<pipeline>).explain("executionStats")`);
  - `<collection>` defaults to mongoose's usual pluralisation of the model, lowercased and pluralised, with an editable input;
  - Copy button.
- **"Reveal real values"**, shown when the app has a key and this signature has an `encryptedSample`:
  - passphrase dialog;
  - fetches the wrapped key through the BFF, unwraps it and decrypts in the browser;
  - shows the real query and the real Compass command, with copy;
  - "Hide" clears it from memory.
  - The passphrase and plaintext are never sent anywhere, never stored, and never logged.
  - A wrong passphrase gives "That passphrase didn't unlock the key."
- When the app has no key, the card offers "Enable real values in Settings" (for ADMIN+).

### Hardening

- Security headers on all pages via `next.config.ts` `headers()`:
  - `Content-Security-Policy` with `default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'`;
  - `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `Permissions-Policy: camera=(), microphone=(), geolocation=()`.
  - A nonce-based `script-src` (dropping `'unsafe-inline'`) is a recorded follow-up.
- Homepage copy "Shapes, never values" becomes "Shapes by default. Values only if you hold the key." The privacy section adds one line about opt-in end-to-end encryption.

## Constraints

- No new npm dependencies. Web Crypto only.
- Anything not opted in behaves exactly as today:
  - an SDK without `sampleKey` sends identical payloads;
  - the API without a key stores nothing new.
- Plaintext values and passphrases never reach the API or logs. Tests prove the BFF and API never receive a plaintext or passphrase field.
- All existing tests stay green. Migrations are additive (nullable columns).
- Web styling follows Mist (glass cards, pill buttons, `accent-text` for text).
- Commits: conventional, no co-author trailers. Never push.

## Non-goals

Per-person decrypt access; key escrow or recovery; decrypting on the server; alerts, overview and the other C2 pages;
publishing a new SDK version to npm (a release step for later).

## Anti-goals

- A design where this service could read values.
- A passphrase or plaintext in any request, log or storage.
- Silently sending values when the customer didn't opt in.
- A sidebar or pagination change that breaks the existing filters or URL sharing.
