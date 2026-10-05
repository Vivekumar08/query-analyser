# Email Verification and Password Reset Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the API email verification and password recovery, so a public signup page is safe to open and a forgotten password is no longer unrecoverable.

**Architecture:** A `VerificationToken` table mirroring the existing `RefreshToken` — 256-bit random, SHA-256 at rest, consumed atomically. One `mailer.ts` seam over SMTP so the provider is a config change. Four endpoints whose request side cannot be used to enumerate accounts, and a `requireVerified` preHandler that gates user routes but deliberately does not gate ingest.

**Tech Stack:** Fastify 5, Prisma 7, PostgreSQL 17, nodemailer, zod, vitest, TypeScript (strict, `noUncheckedIndexedAccess`).

**Spec:** `docs/superpowers/specs/2026-10-03-email-verification-and-password-reset-design.md`

## Global Constraints

- Tests run from `apps/api` with `npx vitest run`. Baseline is **206 passing**. One pre-existing flake lives in `src/ingest/e2e.test.ts` (~1 run in 3, `mongodb-memory-server` startup under load) — it is not yours, do not chase it, and do not let it mask a real failure: if the suite is red, check whether that file is the only casualty.
- `npx tsc --noEmit` from `apps/api` must stay clean. No `any` casts.
- Local Postgres is Homebrew at `postgresql://qa:qa@localhost:5432/qa`. **Docker is dead on this machine** — nothing may depend on it.
- Commit with `git -c user.name=vivekumar08 -c user.email=vivekumar2003bsr@gmail.com commit -m "..."`. Do not push.
- **Do not use `git checkout --`, `git stash`, or bare `cp` to undo a mutation.** `cp` is aliased to `cp -i` here and silently declines overwrites. Use Edit, or `/bin/cp -f`.
- **After any restore, grep for the thing you removed, then `git diff HEAD -- <file>`.** A clean `git status` is not evidence a restore worked.
- **A mutation run that passes means your mutation did not apply**, or your fixture does not reach the mutated branch. Check both before concluding a test is weak.
- **Every gate gets a test that FAILS when the gate is removed.** This was the main review finding in six of nine tasks of the previous plan.
- **Tokens never appear in a URL.** The confirm endpoints are POST with the token in the body. The emailed link points at the *web* app, which POSTs it. Never add a `GET /verify?token=` variant — Fastify logs `req.url` and that is exactly how the invite token leaked once.
- Secrets come from the environment only. `SMTP_PASS` is never written to a file in the repo, never logged, and never echoed in an error.

---

### Task 1: Schema — verification tokens and a verified timestamp

**Files:**
- Modify: `apps/api/prisma/schema.prisma`
- Create: `apps/api/prisma/migrations/<timestamp>_email_verification/migration.sql` (generated)
- Test: `apps/api/src/auth/verification.schema.test.ts`

**Interfaces:**
- Produces: `VerificationToken` model, `TokenPurpose` enum (`VERIFY` | `RESET`), `User.emailVerifiedAt`

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/auth/verification.schema.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { buildApp } from '../app.js';
import type { FastifyInstance } from 'fastify';

let app: FastifyInstance;

beforeEach(async () => {
  app = await buildApp({ logger: false });
});

afterAll(async () => {
  await app?.close();
});

async function user(email: string) {
  return app.prisma.user.create({
    data: { email, name: 'Schema', passwordHash: 'x' },
  });
}

describe('VerificationToken schema', () => {
  it('stores a token with a purpose and an expiry, unverified by default', async () => {
    const u = await user(`sch-${Date.now()}@x.io`);
    expect(u.emailVerifiedAt).toBeNull();

    const row = await app.prisma.verificationToken.create({
      data: {
        userId: u.id,
        tokenHash: `hash-${Date.now()}`,
        purpose: 'VERIFY',
        expiresAt: new Date(Date.now() + 86_400_000),
      },
    });
    expect(row.purpose).toBe('VERIFY');
    expect(row.consumedAt).toBeNull();
  });

  it('rejects a duplicate tokenHash', async () => {
    const u = await user(`dup-${Date.now()}@x.io`);
    const hash = `dup-hash-${Date.now()}`;
    const base = { userId: u.id, tokenHash: hash, purpose: 'RESET' as const, expiresAt: new Date(Date.now() + 3_600_000) };
    await app.prisma.verificationToken.create({ data: base });
    await expect(app.prisma.verificationToken.create({ data: base })).rejects.toThrow();
  });

  it('cascades when the user is deleted', async () => {
    const u = await user(`cas-${Date.now()}@x.io`);
    await app.prisma.verificationToken.create({
      data: { userId: u.id, tokenHash: `cas-${Date.now()}`, purpose: 'VERIFY', expiresAt: new Date(Date.now() + 1000) },
    });
    await app.prisma.user.delete({ where: { id: u.id } });
    expect(await app.prisma.verificationToken.count({ where: { userId: u.id } })).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && npx vitest run src/auth/verification.schema.test.ts`
Expected: FAIL — `verificationToken` does not exist on the Prisma client.

- [ ] **Step 3: Add the schema**

In `apps/api/prisma/schema.prisma`, add `emailVerifiedAt` to `User` and the relation:

```prisma
model User {
  id                 String              @id @default(uuid())
  email              String              @unique
  passwordHash       String
  name               String
  isPlatformAdmin    Boolean             @default(false)
  emailVerifiedAt    DateTime?           @db.Timestamptz(3)
  createdAt          DateTime            @default(now()) @db.Timestamptz(3)
  memberships        Membership[]
  refreshTokens      RefreshToken[]
  verificationTokens VerificationToken[]
}
```

Then the new model and enum:

```prisma
enum TokenPurpose {
  VERIFY
  RESET
}

/// Single-use, time-boxed tokens for email verification and password reset.
/// Mirrors RefreshToken: the plaintext is delivered once in a link and only
/// its SHA-256 is stored, so a database read yields nothing usable.
model VerificationToken {
  id         String       @id @default(uuid())
  userId     String
  tokenHash  String       @unique
  purpose    TokenPurpose
  expiresAt  DateTime     @db.Timestamptz(3)
  consumedAt DateTime?    @db.Timestamptz(3)
  createdAt  DateTime     @default(now()) @db.Timestamptz(3)
  user       User         @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@index([userId, purpose])
}
```

- [ ] **Step 4: Generate and apply the migration**

```bash
cd apps/api
npx prisma migrate dev --name email_verification
```

Expected: a new migration directory, and the client regenerated.

- [ ] **Step 5: Run test to verify it passes**

Run: `cd apps/api && npx vitest run src/auth/verification.schema.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 6: Run the whole suite and commit**

Run: `cd apps/api && npx vitest run && npx tsc --noEmit`
Expected: 209 (206 + 3), typecheck clean.

```bash
git add apps/api/prisma apps/api/src/auth/verification.schema.test.ts
git -c user.name=vivekumar08 -c user.email=vivekumar2003bsr@gmail.com commit -m "feat(api): verification token model and a verified-at timestamp

Mirrors RefreshToken: the plaintext is delivered once in a link and only its
SHA-256 is stored, so reading the table yields nothing usable."
```

---

### Task 2: The mailer seam

**Files:**
- Create: `apps/api/src/mail/mailer.ts`
- Create: `apps/api/src/mail/mailer.test.ts`
- Modify: `apps/api/src/config.ts` (SMTP env), `apps/api/package.json` (nodemailer)

**Interfaces:**
- Produces: `createMailer(config, logger) => { send(msg: MailMessage): Promise<void> }`, `MailMessage = { to: string; subject: string; text: string; html?: string }`

- [ ] **Step 1: Install nodemailer**

```bash
cd apps/api && npm pkg set dependencies.nodemailer="^6.9.16" && npm pkg set devDependencies.@types/nodemailer="^6.4.17"
cd ../.. && pnpm install
```

- [ ] **Step 2: Write the failing test**

Create `apps/api/src/mail/mailer.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { createMailer } from './mailer.js';

const config = {
  SMTP_HOST: 'smtp.example.com',
  SMTP_PORT: 587,
  SMTP_SECURE: false,
  SMTP_USER: 'user@example.com',
  SMTP_PASS: 'secret-value',
  SMTP_FROM_NAME: 'Vigor Tempo',
};

const logger = () => ({ error: vi.fn(), info: vi.fn() });

describe('createMailer', () => {
  it('sends through the transport with a From built from the configured name', async () => {
    const sendMail = vi.fn().mockResolvedValue({ messageId: 'x' });
    const log = logger();
    const mailer = createMailer(config, log as never, { sendMail } as never);

    await mailer.send({ to: 'a@b.io', subject: 'Hello', text: 'Body' });

    expect(sendMail).toHaveBeenCalledTimes(1);
    const arg = sendMail.mock.calls[0]![0] as Record<string, string>;
    expect(arg.to).toBe('a@b.io');
    expect(arg.subject).toBe('Hello');
    expect(arg.from).toContain('Vigor Tempo');
    expect(arg.from).toContain('user@example.com');
  });

  it('never puts the password in a log line when the transport fails', async () => {
    const sendMail = vi.fn().mockRejectedValue(new Error('535 auth failed for secret-value'));
    const log = logger();
    const mailer = createMailer(config, log as never, { sendMail } as never);

    await mailer.send({ to: 'a@b.io', subject: 'S', text: 'T' });

    const logged = JSON.stringify(log.error.mock.calls);
    expect(logged).not.toContain('secret-value');
  });

  it('resolves rather than throwing when the transport fails', async () => {
    // A send failure must never fail the caller's request. Signup succeeding
    // and the mail being retryable is strictly better than losing the account.
    const sendMail = vi.fn().mockRejectedValue(new Error('connection refused'));
    const mailer = createMailer(config, logger() as never, { sendMail } as never);
    await expect(mailer.send({ to: 'a@b.io', subject: 'S', text: 'T' })).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd apps/api && npx vitest run src/mail/mailer.test.ts`
Expected: FAIL — cannot find module `./mailer.js`.

- [ ] **Step 4: Write the implementation**

Create `apps/api/src/mail/mailer.ts`:

```ts
import nodemailer from 'nodemailer';
import type { FastifyBaseLogger } from 'fastify';

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export interface MailerConfig {
  SMTP_HOST: string;
  SMTP_PORT: number;
  SMTP_SECURE: boolean;
  SMTP_USER: string;
  SMTP_PASS: string;
  SMTP_FROM_NAME: string;
}

export interface Mailer {
  send(msg: MailMessage): Promise<void>;
}

interface Transport {
  sendMail(options: Record<string, unknown>): Promise<unknown>;
}

/**
 * The only place in the codebase that knows an SMTP transport exists.
 *
 * Swapping Gmail for a transactional provider is a config change, not a code
 * change — which matters, because Gmail caps around 500 messages a day and
 * mail from a new sender lands in spam more often than a real provider's.
 *
 * `transport` is injectable so tests never open a connection.
 */
export function createMailer(
  config: MailerConfig,
  logger: FastifyBaseLogger,
  transport?: Transport,
): Mailer {
  const tx: Transport =
    transport ??
    nodemailer.createTransport({
      host: config.SMTP_HOST,
      port: config.SMTP_PORT,
      secure: config.SMTP_SECURE,
      auth: { user: config.SMTP_USER, pass: config.SMTP_PASS },
    });

  const from = `${config.SMTP_FROM_NAME} <${config.SMTP_USER}>`;

  return {
    async send(msg) {
      try {
        await tx.sendMail({ from, to: msg.to, subject: msg.subject, text: msg.text, html: msg.html });
      } catch (err) {
        // A provider's error text can quote the credentials it rejected, so
        // log the shape of the failure and never the error verbatim.
        logger.error(
          { to: msg.to, subject: msg.subject, err: err instanceof Error ? err.name : 'unknown' },
          'mail send failed',
        );
      }
    },
  };
}
```

Add these to the zod schema in `apps/api/src/config.ts`, inside the existing
`z.object({ ... })`:

```ts
  SMTP_HOST: z.string().min(1),
  SMTP_PORT: z.coerce.number().int().positive().default(587),
  SMTP_SECURE: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
  SMTP_USER: z.string().min(1),
  SMTP_PASS: z.string().min(1),
  SMTP_FROM_NAME: z.string().min(1).default('Vigor Tempo'),
  // Origin of the web app the emailed links point at. The API never serves
  // these paths; it only ever receives the token back in a POST body.
  WEB_ORIGIN: z.string().url().default('http://localhost:3000'),
```

`SMTP_SECURE` goes through `z.enum(...).transform(...)` rather than
`z.coerce.boolean()`, because `z.coerce.boolean()` turns the string `'false'`
into `true` — every non-empty string is truthy. That would silently force TLS
on port 587 and every send would fail.

The five SMTP values have no defaults, so a deployment missing them fails at
boot with the config error rather than at the first send. `loadConfig` already
reports the missing paths by name.

Tests need them present. `apps/api/vitest.config.ts` imports `dotenv/config`, so
config comes from `apps/api/.env`, which is gitignored. Add dummy values there —
the test mailer never opens a connection, so nothing is dialled:

```
SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=test@example.com
SMTP_PASS=not-a-real-password
SMTP_FROM_NAME=Vigor Tempo
WEB_ORIGIN=http://localhost:3000
```

Add the same keys to `apps/api/.env.example` with empty values, which **is**
committed. `SMTP_PASS=` stays empty there — the real app password lives in
EasyPanel's environment and nowhere else.

- [ ] **Step 5: Run test to verify it passes**

Run: `cd apps/api && npx vitest run src/mail/mailer.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 6: Verify the tests are load-bearing**

Change the catch block to `throw err`. The "resolves rather than throwing" test must FAIL. Restore with Edit.

Change the logger call to log `err` directly instead of `err.name`. The password test must FAIL. Restore with Edit, then `git diff HEAD -- apps/api/src/mail/mailer.ts` to confirm.

- [ ] **Step 7: Run the whole suite and commit**

Run: `cd apps/api && npx vitest run && npx tsc --noEmit`

```bash
git add apps/api/src/mail apps/api/src/config.ts apps/api/package.json ../../pnpm-lock.yaml
git -c user.name=vivekumar08 -c user.email=vivekumar2003bsr@gmail.com commit -m "feat(api): one SMTP seam, and a send failure that cannot fail a request

A provider's error text can quote the credentials it rejected, so the failure
is logged by shape and never verbatim."
```

---

### Task 3: Token issue and consume

**Files:**
- Create: `apps/api/src/auth/verification.ts`
- Create: `apps/api/src/auth/verification.test.ts`

**Interfaces:**
- Consumes: `TokenPurpose` from the generated Prisma client
- Produces: `issueVerificationToken(prisma, userId, purpose) => Promise<{ token: string; expiresAt: Date }>`, `consumeVerificationToken(prisma, token, purpose) => Promise<string | null>` (returns the `userId`, or `null`), `VERIFY_TTL_MS`, `RESET_TTL_MS`

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/auth/verification.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { buildApp } from '../app.js';
import {
  issueVerificationToken,
  consumeVerificationToken,
  VERIFY_TTL_MS,
  RESET_TTL_MS,
} from './verification.js';
import type { FastifyInstance } from 'fastify';

let app: FastifyInstance;

beforeEach(async () => {
  app = await buildApp({ logger: false });
});

afterAll(async () => {
  await app?.close();
});

const user = () =>
  app.prisma.user.create({
    data: { email: `ver-${Date.now()}-${Math.random()}@x.io`, name: 'V', passwordHash: 'x' },
  });

describe('token lifetimes', () => {
  it('gives a reset link an hour and a verification link a day', () => {
    // A reset link is a password in disguise; it should live for minutes, not
    // days. Verification is not a credential in the same way.
    expect(RESET_TTL_MS).toBe(3_600_000);
    expect(VERIFY_TTL_MS).toBe(86_400_000);
    expect(RESET_TTL_MS).toBeLessThan(VERIFY_TTL_MS);
  });
});

describe('issueVerificationToken', () => {
  it('never stores the plaintext it returns', async () => {
    const u = await user();
    const { token } = await issueVerificationToken(app.prisma, u.id, 'VERIFY');
    const rows = await app.prisma.verificationToken.findMany({ where: { userId: u.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tokenHash).not.toBe(token);
    expect(rows[0]!.tokenHash).toHaveLength(64);
  });

  it('consumes any outstanding token of the same purpose', async () => {
    // An old link sitting in an old inbox must stop working once a new one is
    // requested.
    const u = await user();
    const first = await issueVerificationToken(app.prisma, u.id, 'VERIFY');
    await issueVerificationToken(app.prisma, u.id, 'VERIFY');
    expect(await consumeVerificationToken(app.prisma, first.token, 'VERIFY')).toBeNull();
  });

  it('leaves a token of a different purpose alone', async () => {
    const u = await user();
    const reset = await issueVerificationToken(app.prisma, u.id, 'RESET');
    await issueVerificationToken(app.prisma, u.id, 'VERIFY');
    expect(await consumeVerificationToken(app.prisma, reset.token, 'RESET')).toBe(u.id);
  });
});

describe('consumeVerificationToken', () => {
  it('returns the user id once and null thereafter', async () => {
    const u = await user();
    const { token } = await issueVerificationToken(app.prisma, u.id, 'VERIFY');
    expect(await consumeVerificationToken(app.prisma, token, 'VERIFY')).toBe(u.id);
    expect(await consumeVerificationToken(app.prisma, token, 'VERIFY')).toBeNull();
  });

  it('rejects an unknown token', async () => {
    expect(await consumeVerificationToken(app.prisma, 'not-a-real-token', 'VERIFY')).toBeNull();
  });

  it('rejects an expired token', async () => {
    const u = await user();
    const { token } = await issueVerificationToken(app.prisma, u.id, 'VERIFY');
    await app.prisma.verificationToken.updateMany({
      where: { userId: u.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    expect(await consumeVerificationToken(app.prisma, token, 'VERIFY')).toBeNull();
  });

  it('rejects a token presented against the wrong purpose', async () => {
    // A verification link must not be usable to set a password.
    const u = await user();
    const { token } = await issueVerificationToken(app.prisma, u.id, 'VERIFY');
    expect(await consumeVerificationToken(app.prisma, token, 'RESET')).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && npx vitest run src/auth/verification.test.ts`
Expected: FAIL — cannot find module `./verification.js`.

- [ ] **Step 3: Write the implementation**

Create `apps/api/src/auth/verification.ts`:

```ts
import { createHash, randomBytes } from 'node:crypto';
import type { PrismaClient } from '../db.js';
import type { TokenPurpose } from '../generated/prisma/enums.js';

/** A verification link is not a credential in the way a reset link is. */
export const VERIFY_TTL_MS = 24 * 3600 * 1000;
/** A reset link is a password in disguise. Minutes, not days. */
export const RESET_TTL_MS = 3600 * 1000;

const hashToken = (t: string) => createHash('sha256').update(t).digest('hex');

const ttlFor = (purpose: TokenPurpose) => (purpose === 'RESET' ? RESET_TTL_MS : VERIFY_TTL_MS);

/**
 * Issues a single-use token, returning the plaintext exactly once.
 *
 * Any outstanding token of the same purpose is consumed first, so requesting a
 * new link invalidates the old one sitting in an old inbox.
 */
export async function issueVerificationToken(
  prisma: PrismaClient,
  userId: string,
  purpose: TokenPurpose,
): Promise<{ token: string; expiresAt: Date }> {
  await prisma.verificationToken.updateMany({
    where: { userId, purpose, consumedAt: null },
    data: { consumedAt: new Date() },
  });

  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + ttlFor(purpose));
  await prisma.verificationToken.create({
    data: { userId, purpose, tokenHash: hashToken(token), expiresAt },
  });
  return { token, expiresAt };
}

/**
 * Consumes a token and returns the user it belongs to, or null.
 *
 * The claim is a single atomic `updateMany` guarded on `consumedAt: null` and
 * an unexpired `expiresAt`: `count === 0` means spent, expired, unknown, or
 * the wrong purpose, and the caller cannot tell which. Read-then-write here
 * would be the same defect the invite flow was fixed for.
 */
export async function consumeVerificationToken(
  prisma: PrismaClient,
  token: string,
  purpose: TokenPurpose,
): Promise<string | null> {
  const tokenHash = hashToken(token);
  const claimed = await prisma.verificationToken.updateMany({
    where: { tokenHash, purpose, consumedAt: null, expiresAt: { gt: new Date() } },
    data: { consumedAt: new Date() },
  });
  if (claimed.count === 0) return null;

  const row = await prisma.verificationToken.findUnique({
    where: { tokenHash },
    select: { userId: true },
  });
  return row?.userId ?? null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/api && npx vitest run src/auth/verification.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Verify the tests are load-bearing**

Remove `consumedAt: null` from the `updateMany` guard in `consumeVerificationToken`. The "returns the user id once and null thereafter" test must FAIL. Restore with Edit.

Remove `purpose` from the same guard. The wrong-purpose test must FAIL. Restore with Edit.

Remove the `updateMany` that consumes outstanding tokens in `issueVerificationToken`. The "consumes any outstanding token" test must FAIL. Restore with Edit, then `git diff HEAD -- apps/api/src/auth/verification.ts` to confirm.

- [ ] **Step 6: Run the whole suite and commit**

Run: `cd apps/api && npx vitest run && npx tsc --noEmit`

```bash
git add apps/api/src/auth/verification.ts apps/api/src/auth/verification.test.ts
git -c user.name=vivekumar08 -c user.email=vivekumar2003bsr@gmail.com commit -m "feat(api): single-use verification and reset tokens

The claim is one atomic updateMany guarded on consumedAt, purpose and expiry,
so a spent, expired, unknown or wrong-purpose token are indistinguishable to
the caller. Read-then-write here is the defect the invite flow was fixed for."
```

---

### Task 4: The four endpoints

**Files:**
- Modify: `apps/api/src/auth/routes.ts`
- Create: `apps/api/src/auth/verificationRoutes.test.ts`

**Interfaces:**
- Consumes: `issueVerificationToken`, `consumeVerificationToken` (Task 3); `createMailer` (Task 2); `hashPassword` from `./password.js`; `app.authenticate`
- Produces: `POST /v1/auth/verify/request`, `POST /v1/auth/verify/confirm`, `POST /v1/auth/password/request`, `POST /v1/auth/password/confirm`

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/auth/verificationRoutes.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { buildApp } from '../app.js';
import type { FastifyInstance } from 'fastify';

let app: FastifyInstance;

beforeEach(async () => {
  app = await buildApp({ logger: false });
});

afterAll(async () => {
  await app?.close();
});

async function signup(email: string) {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/auth/signup',
    payload: { email, password: 'correct-horse-battery-staple-9', name: 'V' },
  });
  return res.json().accessToken as string;
}

/** Reads the one outstanding token for a user straight from the database. */
async function tokenFor(email: string, purpose: 'VERIFY' | 'RESET') {
  const u = await app.prisma.user.findUniqueOrThrow({ where: { email } });
  return app.prisma.verificationToken.findFirst({
    where: { userId: u.id, purpose, consumedAt: null },
  });
}

describe('verification', () => {
  it('signup issues a verification token and leaves the user unverified', async () => {
    const email = `v1-${Date.now()}@x.io`;
    await signup(email);
    const u = await app.prisma.user.findUniqueOrThrow({ where: { email } });
    expect(u.emailVerifiedAt).toBeNull();
    expect(await tokenFor(email, 'VERIFY')).not.toBeNull();
  });

  it('confirms with a valid token and is idempotent on reuse', async () => {
    const email = `v2-${Date.now()}@x.io`;
    const token = await signup(email);
    const row = await tokenFor(email, 'VERIFY');
    expect(row).not.toBeNull();

    // The plaintext is not readable from the row, so request a fresh one
    // through the resend endpoint and capture it from the mail fake instead.
    const resend = await app.inject({
      method: 'POST',
      url: '/v1/auth/verify/request',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(resend.statusCode).toBe(202);

    const sent = app.sentMail.at(-1);
    expect(sent).toBeDefined();
    const plaintext = /token=([A-Za-z0-9_-]+)/.exec(sent!.text)?.[1];
    expect(plaintext).toBeTruthy();

    const ok = await app.inject({
      method: 'POST',
      url: '/v1/auth/verify/confirm',
      payload: { token: plaintext },
    });
    expect(ok.statusCode).toBe(200);

    const u = await app.prisma.user.findUniqueOrThrow({ where: { email } });
    expect(u.emailVerifiedAt).not.toBeNull();

    const again = await app.inject({
      method: 'POST',
      url: '/v1/auth/verify/confirm',
      payload: { token: plaintext },
    });
    expect(again.statusCode).toBe(400);
  });
});

describe('password reset', () => {
  it('resets the password and revokes every refresh token', async () => {
    const email = `p1-${Date.now()}@x.io`;
    await signup(email);

    const req = await app.inject({
      method: 'POST',
      url: '/v1/auth/password/request',
      payload: { email },
    });
    expect(req.statusCode).toBe(202);

    const sent = app.sentMail.at(-1)!;
    const plaintext = /token=([A-Za-z0-9_-]+)/.exec(sent.text)![1];

    const done = await app.inject({
      method: 'POST',
      url: '/v1/auth/password/confirm',
      payload: { token: plaintext, password: 'a-completely-new-password-1' },
    });
    expect(done.statusCode).toBe(200);

    const u = await app.prisma.user.findUniqueOrThrow({ where: { email } });
    const live = await app.prisma.refreshToken.count({ where: { userId: u.id, consumedAt: null } });
    expect(live).toBe(0);

    const login = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email, password: 'a-completely-new-password-1' },
    });
    expect(login.statusCode).toBe(200);
  });
});

describe('account enumeration', () => {
  it('answers identically for a known and an unknown email', async () => {
    const known = `e1-${Date.now()}@x.io`;
    await signup(known);

    const a = await app.inject({ method: 'POST', url: '/v1/auth/password/request', payload: { email: known } });
    const b = await app.inject({
      method: 'POST',
      url: '/v1/auth/password/request',
      payload: { email: `nobody-${Date.now()}@x.io` },
    });

    expect(a.statusCode).toBe(b.statusCode);
    expect(a.json()).toEqual(b.json());
  });

  it('does not wait for the mail to send, so latency carries no signal', async () => {
    // If the handler awaited SMTP only when the account exists, response time
    // would leak existence even with identical bodies.
    const known = `e2-${Date.now()}@x.io`;
    await signup(known);
    app.mailDelayMs = 400;

    const started = Date.now();
    await app.inject({ method: 'POST', url: '/v1/auth/password/request', payload: { email: known } });
    const elapsed = Date.now() - started;

    expect(elapsed).toBeLessThan(300);
    app.mailDelayMs = 0;
  });
});
```

This test relies on two test seams on the app instance — `app.sentMail` and `app.mailDelayMs`. Add them in Step 3.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && npx vitest run src/auth/verificationRoutes.test.ts`
Expected: FAIL — the routes 404 and `app.sentMail` is undefined.

- [ ] **Step 3: Write the implementation**

Register the mailer in `apps/api/src/app.ts` after the config decoration, with a capture array used in tests:

```ts
const sentMail: MailMessage[] = [];
app.decorate('sentMail', sentMail);
app.decorate('mailDelayMs', 0);

const mailer: Mailer =
  config.NODE_ENV === 'test'
    ? {
        async send(msg) {
          if (app.mailDelayMs > 0) await new Promise((r) => setTimeout(r, app.mailDelayMs));
          sentMail.push(msg);
        },
      }
    : createMailer(config, app.log);
app.decorate('mailer', mailer);
```

The capture array and the delay knob exist only so the route tests can read what
was sent and prove the handler does not wait for it. Declare all three on the
instance, in `apps/api/src/app.ts` beside the existing augmentation:

```ts
declare module 'fastify' {
  interface FastifyInstance {
    mailer: Mailer;
    /** Test seam: every message the fake transport accepted, in order. */
    sentMail: MailMessage[];
    /** Test seam: artificial send latency, used to prove the reply is not awaited. */
    mailDelayMs: number;
  }
}
```

`app.decorate('mailDelayMs', 0)` registers a plain writable property, so a test
assigning `app.mailDelayMs = 400` works. `config.NODE_ENV` is `'test'` under
vitest, which is what selects the fake.

Add the four routes to `apps/api/src/auth/routes.ts`:

```ts
const confirmSchema = z.object({ token: z.string().min(1).max(200) });
const emailSchema = z.object({ email: z.string().email().max(200) });
const resetSchema = z.object({
  token: z.string().min(1).max(200),
  password: z.string().min(12).max(200),
});

const verifyLink = (token: string) => `${app.config.WEB_ORIGIN}/verify?token=${token}`;
const resetLink = (token: string) => `${app.config.WEB_ORIGIN}/reset-password?token=${token}`;

app.post(
  '/v1/auth/verify/request',
  { preHandler: [app.authenticate], config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
  async (req, reply) => {
    const user = await app.prisma.user.findUnique({
      where: { id: req.user.id },
      select: { id: true, email: true, emailVerifiedAt: true },
    });
    if (!user) return reply.code(404).send({ error: 'Not Found' });
    if (user.emailVerifiedAt) return reply.code(202).send({ status: 'already verified' });

    const { token } = await issueVerificationToken(app.prisma, user.id, 'VERIFY');
    await app.mailer.send({
      to: user.email,
      subject: 'Confirm your email',
      text: `Confirm your email to finish setting up your account:\n\n${verifyLink(token)}\n\nThis link expires in 24 hours.`,
    });
    return reply.code(202).send({ status: 'sent' });
  },
);

app.post('/v1/auth/verify/confirm', async (req, reply) => {
  const parsed = confirmSchema.safeParse(req.body);
  if (!parsed.success) return reply.code(400).send({ error: 'invalid body' });

  const userId = await consumeVerificationToken(app.prisma, parsed.data.token, 'VERIFY');
  if (!userId) return reply.code(400).send({ error: 'invalid or expired token' });

  await app.prisma.user.update({ where: { id: userId }, data: { emailVerifiedAt: new Date() } });
  return reply.send({ status: 'verified' });
});

app.post(
  '/v1/auth/password/request',
  { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
  async (req, reply) => {
    const parsed = emailSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid body' });
    const email = parsed.data.email.toLowerCase();

    // Reply FIRST, then do the work. An awaited lookup-and-send would make
    // response latency reveal whether the account exists, which is the same
    // oracle the identical body is written to avoid.
    void reply.code(202).send({ status: 'sent' });

    const user = await app.prisma.user.findUnique({ where: { email }, select: { id: true, email: true } });
    if (!user) return;

    const { token } = await issueVerificationToken(app.prisma, user.id, 'RESET');
    await app.mailer.send({
      to: user.email,
      subject: 'Reset your password',
      text: `Reset your password:\n\n${resetLink(token)}\n\nThis link expires in 1 hour. If you did not ask for this, ignore it.`,
    });
  },
);

app.post('/v1/auth/password/confirm', async (req, reply) => {
  const parsed = resetSchema.safeParse(req.body);
  if (!parsed.success) return reply.code(400).send({ error: 'invalid body' });

  const userId = await consumeVerificationToken(app.prisma, parsed.data.token, 'RESET');
  if (!userId) return reply.code(400).send({ error: 'invalid or expired token' });

  await app.prisma.user.update({
    where: { id: userId },
    data: { passwordHash: await hashPassword(parsed.data.password) },
  });

  // A password change invalidates every session. The API already revokes a
  // refresh family on replay; resetting after a compromise should do at least
  // as much.
  await app.prisma.refreshToken.updateMany({
    where: { userId, consumedAt: null },
    data: { consumedAt: new Date() },
  });

  return reply.send({ status: 'reset' });
});
```

Signup sends the first verification mail: after the `issue(reply, user.id)` call, issue a `VERIFY` token and send it, without awaiting in a way that can fail the signup.


- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/api && npx vitest run src/auth/verificationRoutes.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Verify the tests are load-bearing**

Change `password/request` to `await` the lookup and send before replying. The "does not wait for the mail" test must FAIL. Restore with Edit.

Change the unknown-email path to return 404 instead of the shared 202. The enumeration test must FAIL. Restore with Edit.

Remove the refresh-token revocation from `password/confirm`. The reset test must FAIL. Restore with Edit, then `git diff HEAD -- apps/api/src/auth/routes.ts` to confirm.

- [ ] **Step 6: Run the whole suite and commit**

Run: `cd apps/api && npx vitest run && npx tsc --noEmit`

```bash
git add apps/api/src/auth apps/api/src/app.ts apps/api/src/config.ts
git -c user.name=vivekumar08 -c user.email=vivekumar2003bsr@gmail.com commit -m "feat(api): verify an email, and recover a forgotten password

The request endpoints reply before doing any work, so response latency cannot
reveal whether an account exists — an identical body alone would not have been
enough. A completed reset revokes every live refresh token."
```

---

### Task 5: The verified gate

**Files:**
- Modify: `apps/api/src/plugins/auth.ts`
- Modify: `apps/api/src/orgs/routes.ts`, `apps/api/src/apps/routes.ts`, `apps/api/src/orgs/invites.ts`, `apps/api/src/analysis/routes.ts`
- Create: `apps/api/src/auth/requireVerified.test.ts`

**Interfaces:**
- Consumes: `app.authenticate`
- Produces: `app.requireVerified` — a preHandler returning 403 `{ error: 'email not verified' }` for an unverified user

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/auth/requireVerified.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { buildApp } from '../app.js';
import type { FastifyInstance } from 'fastify';

let app: FastifyInstance;

beforeEach(async () => {
  app = await buildApp({ logger: false });
});

afterAll(async () => {
  await app?.close();
});

async function unverified(email: string) {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/auth/signup',
    payload: { email, password: 'correct-horse-battery-staple-9', name: 'U' },
  });
  return res.json().accessToken as string;
}

async function verify(email: string) {
  await app.prisma.user.update({ where: { email }, data: { emailVerifiedAt: new Date() } });
}

describe('requireVerified', () => {
  it('403s an unverified user on a gated route', async () => {
    const email = `g1-${Date.now()}@x.io`;
    const token = await unverified(email);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/orgs',
      headers: { authorization: `Bearer ${token}` },
      payload: { name: 'Nope' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'email not verified' });
  });

  it('lets the same user through once verified', async () => {
    const email = `g2-${Date.now()}@x.io`;
    const token = await unverified(email);
    await verify(email);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/orgs',
      headers: { authorization: `Bearer ${token}` },
      payload: { name: 'Yes' },
    });
    expect(res.statusCode).toBe(201);
  });

  it('never gates the auth routes, or an unverified user cannot verify', async () => {
    const email = `g3-${Date.now()}@x.io`;
    const token = await unverified(email);

    const resend = await app.inject({
      method: 'POST',
      url: '/v1/auth/verify/request',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(resend.statusCode).toBe(202);

    const me = await app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(me.statusCode).toBe(200);
  });

  it('never gates ingest — a key belongs to an app, not to a human', async () => {
    // One unverified teammate must not stop a customer's data flowing.
    const email = `g4-${Date.now()}@x.io`;
    const token = await unverified(email);
    await verify(email);

    const org = (
      await app.inject({
        method: 'POST',
        url: '/v1/orgs',
        headers: { authorization: `Bearer ${token}` },
        payload: { name: 'Ingest Co' },
      })
    ).json();
    const appRow = (
      await app.inject({
        method: 'POST',
        url: `/v1/orgs/${org.id}/apps`,
        headers: { authorization: `Bearer ${token}` },
        payload: { name: 'ing', env: 'production' },
      })
    ).json();
    const key = (
      await app.inject({
        method: 'POST',
        url: `/v1/apps/${appRow.id}/keys`,
        headers: { authorization: `Bearer ${token}` },
      })
    ).json().key as string;

    // Now un-verify the owner. Ingest must be unaffected.
    await app.prisma.user.update({ where: { email }, data: { emailVerifiedAt: null } });

    const bucket = new Date().toISOString().slice(0, 13).replace(/[-T]/g, '');
    const res = await app.inject({
      method: 'POST',
      url: '/v1/ingest',
      headers: { authorization: `Bearer ${key}` },
      payload: {
        app: 'ing',
        env: 'production',
        host: 'h',
        sdkVersion: '0.1.0',
        bucket,
        thresholdMs: 0,
        dropped: 0,
        items: [
          {
            signature: 'users.find({email})',
            hash: 'abcdef0123456789',
            model: 'users',
            operation: 'find',
            filterShape: [],
            sortKeys: [],
            stages: [],
            count: 1,
            totalMs: 10,
            maxMs: 10,
            lastMs: 10,
            lastTs: Date.now(),
            hist: [1, 0, 0, 0, 0, 0, 0, 0],
            sample: null,
          },
        ],
      },
    });
    expect(res.statusCode).toBe(202);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && npx vitest run src/auth/requireVerified.test.ts`
Expected: FAIL — the gated route returns 201 rather than 403.

- [ ] **Step 3: Write the implementation**

In `apps/api/src/plugins/auth.ts`, add alongside `authenticate`:

```ts
/**
 * Blocks an unverified account.
 *
 * Deliberately NOT applied to:
 *  - `/v1/auth/*` and `/v1/me` — an unverified user must be able to log in,
 *    refresh, and request or confirm verification. Gating these locks everyone
 *    out of the only path that would unblock them.
 *  - `/v1/ingest` — authenticated by an app's ingest key, not by a user. A
 *    customer's data must keep flowing regardless of any human's email state.
 */
app.decorate('requireVerified', async (req: FastifyRequest, reply: FastifyReply) => {
  const user = await app.prisma.user.findUnique({
    where: { id: req.user.id },
    select: { emailVerifiedAt: true },
  });
  if (!user?.emailVerifiedAt) {
    await reply.code(403).send({ error: 'email not verified' });
  }
});
```

Add it to the `FastifyInstance` augmentation beside `authenticate`.

Then add `app.requireVerified` to the preHandler array of every authenticated user route in `orgs/routes.ts`, `apps/routes.ts`, `orgs/invites.ts` and `analysis/routes.ts`, immediately after `app.authenticate` and before any role gate. Do **not** touch `ingestRoutes`, and do not touch the `/v1/auth/*` routes or `/v1/me`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/api && npx vitest run src/auth/requireVerified.test.ts`
Expected: PASS, 4 tests.

Other suites will now fail, because their fixtures sign up and never verify. Fix them by verifying the user in the helper that creates it — one line in each test file's signup helper:

```ts
await app.prisma.user.update({ where: { email }, data: { emailVerifiedAt: new Date() } });
```

- [ ] **Step 5: Verify the gate is load-bearing**

Remove `app.requireVerified` from the `POST /v1/orgs` preHandler. The first test must FAIL. Restore with Edit.

Add `app.requireVerified` to the ingest route's preHandler. The ingest test must FAIL. Restore with Edit, then `git diff HEAD` to confirm both.

- [ ] **Step 6: Run the whole suite and commit**

Run: `cd apps/api && npx vitest run && npx tsc --noEmit`

```bash
git add apps/api/src
git -c user.name=vivekumar08 -c user.email=vivekumar2003bsr@gmail.com commit -m "feat(api): block unverified accounts, except where it would do harm

Not on /v1/auth or /v1/me, or an unverified user could never reach the path
that unblocks them. Not on /v1/ingest, which a key authenticates rather than a
human — one unverified teammate must not stop a customer's data flowing."
```

---

### Task 6: Deploy and verify live

**Files:** none

- [ ] **Step 1: Set the SMTP environment on the EasyPanel service**

`SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM_NAME`, and `WEB_ORIGIN`. The password is set in the EasyPanel UI only — it must not appear in any file in the repo, in a build arg, or in a log line.

- [ ] **Step 2: Deploy and confirm the service is healthy**

```bash
curl -s https://prod-query-analyser-api.dhql6p.easypanel.host/healthz
```
Expected: `{"status":"ok"}`.

If the build fails, read the build log before changing anything — the API's Dockerfile traps are documented in `apps/api/README.md`.

- [ ] **Step 3: Verify a real email arrives**

Sign up with an address you can read:

```bash
curl -s -X POST "$BASE/v1/auth/signup" -H 'content-type: application/json' \
  -d '{"email":"<your address>","password":"correct-horse-battery-staple-9","name":"Live"}'
```

Expected: 201, and a verification mail in the inbox within a minute. If it lands in spam, note it — Gmail SMTP from a new sender frequently does, and that is the signal to move to a transactional provider before the home page is public.

- [ ] **Step 4: Verify the gate live**

With the access token from Step 3, before clicking the link:

```bash
curl -s -o /dev/null -w "%{http_code}\n" -X POST "$BASE/v1/orgs" \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{"name":"Gate"}'
```
Expected: `403`.

Click the verification link's token through `POST /v1/auth/verify/confirm`, then repeat. Expected: `201`.

- [ ] **Step 5: Verify password reset end to end**

Request a reset, follow the link's token through `POST /v1/auth/password/confirm`, then confirm the old password fails and the new one works.

- [ ] **Step 6: Confirm no token reached the logs**

Check the service logs for the verification and reset tokens. Expected: absent. Tokens travel in POST bodies, which Fastify does not log — this step confirms that no `GET` variant crept in.

---

## Self-Review

**Spec coverage**

| Spec section | Task |
|---|---|
| `VerificationToken`, `TokenPurpose`, `emailVerifiedAt` | 1 |
| SHA-256 at rest, 24h / 1h TTLs, atomic single-use | 1, 3 |
| Requesting a token consumes the outstanding one | 3 |
| `nodemailer` over SMTP behind one `send()` seam | 2 |
| Send failure must not fail the request | 2 |
| The four endpoints | 4 |
| Identical response for known vs unknown email | 4 |
| Rate limiting on the request endpoints, keyed on IP | 4 |
| Reset revokes the refresh family | 4 |
| `requireVerified` and its three exclusions | 5 |
| Ingest explicitly not gated | 5 |
| Deploy and live verification | 6 |

Two spec lines land in Task 2 rather than their own task: "a send failure must
not fail the request" is pinned by the mailer's resolve-on-failure test, and
signup's first mail is sent through the same non-awaited seam, so there is no
path by which SMTP can fail a signup.

**Placeholder scan:** clean after one fix — Task 4 said "add `WEB_ORIGIN` to the
config schema if it is not already present", which is a decision left to the
implementer. It is not present; Task 2 now adds it with the exact zod line, and
the conditional is gone.

**Checked against the real code, three corrections made:**

- `SMTP_SECURE` cannot use `z.coerce.boolean()`. The string `'false'` is truthy,
  so the documented `SMTP_SECURE=false` would have forced TLS on port 587 and
  every send would have failed. It goes through
  `z.enum(['true','false']).transform(...)` instead.
- The spec rate-limits **both** request endpoints. The plan only had it on
  `password/request`. `verify/request` now carries the same limit.
- The three test seams on the instance (`mailer`, `sentMail`, `mailDelayMs`)
  needed a `declare module 'fastify'` block, or Task 4's tests would not
  typecheck under `tsc --noEmit`. Added.

`zod` is 3.24 here, so `z.string().email()` is correct and not the Zod 4
`z.email()`. The plan's tests call `buildApp({ logger: false })`, matching every
existing test file.

**One hazard confirmed safe rather than guessed at:** `requireVerified` reads
`req.user.id`, which `authenticate` sets. If an unauthenticated request reached
it, that would throw. It cannot — Fastify's preHandler chain aborts once a hook
sends a reply, which is the same assumption `requireRole` in `orgs/rbac.ts`
already makes on the line `userId: req.user.id`. `requirePlatformAdmin` verifies
the JWT itself for a different reason, documented in its own comment: it needs
to branch on the outcome *afterwards*, which a preHandler chain cannot express.

**Type consistency:** `TokenPurpose` (Task 1) is used by name in Tasks 3 and 4. `issueVerificationToken` / `consumeVerificationToken` (Task 3) are called in Task 4 with the signatures Task 3 defines. `Mailer` and `MailMessage` (Task 2) are used in Task 4's app wiring. `app.requireVerified` (Task 5) matches the decoration Task 5 declares.

**One thing the spec left implicit, settled here:** the spec says the verification and reset links need the same log redaction the invite token has. They do not, because the emailed link points at the *web* app and the API only ever receives the token in a POST body, which Fastify does not log. The plan therefore forbids a `GET` variant instead, and Task 6 Step 6 checks the logs to confirm.
