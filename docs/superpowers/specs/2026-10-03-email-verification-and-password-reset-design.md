# Email verification and password reset

Date: 2026-10-03
Repo: `query-analyser` (`apps/api`)
Phase: 4.5 — a backend phase inserted before the customer dashboard

The auth surface today is `signup`, `login`, `refresh`, `logout` and `/v1/me`.
There is no email of any kind in the project: no provider, no templates, no
`emailVerifiedAt`. Invites were shipped deliberately without it — the token is
returned once for the caller to deliver by hand.

That was the right call while the only user was the person building it. It is
the wrong call for a public signup page, for two reasons:

- **A forgotten password is unrecoverable.** There is no reset path at all. This
  is the more urgent of the two gaps and the one nobody asked about.
- **Signup is open.** Rate limiting caps the rate, not the total.

This phase adds both, because they need the same missing piece.

## Why this comes before the dashboard

The dashboard's first-run path is signup → create app → copy key → see data.
Blocking unverified accounts puts an email round trip inside that path, which
changes the onboarding screens and every route guard. Building onboarding
against today's unverified signup and then rebuilding it is the predictable
outcome of the other order.

## Provider

`nodemailer` over plain SMTP. Every value from the environment:

| Variable | Notes |
|---|---|
| `SMTP_HOST` | |
| `SMTP_PORT` | |
| `SMTP_SECURE` | `false` for STARTTLS on 587 |
| `SMTP_USER` | |
| `SMTP_PASS` | **secret** — environment only, never a file in the repo |
| `SMTP_FROM_NAME` | display name on the From header |

The first deployment uses Gmail SMTP. Two limits to know rather than discover:
Gmail caps around 500 messages a day, and mail from a new sender on a shared
domain lands in spam more often than a transactional provider does. Fine for
early users; swap before publicising the home page.

So `apps/api/src/mail/mailer.ts` exposes exactly one function, `send({ to,
subject, text, html })`. Nothing else in the codebase knows a transport exists,
and replacing Gmail with Postmark or SES is a config change.

## Tokens

A new `VerificationToken` model, mirroring `RefreshToken`, which this codebase
already got right:

```prisma
model VerificationToken {
  id         String    @id @default(uuid())
  userId     String
  tokenHash  String    @unique
  purpose    TokenPurpose
  expiresAt  DateTime  @db.Timestamptz(3)
  consumedAt DateTime? @db.Timestamptz(3)
  createdAt  DateTime  @default(now()) @db.Timestamptz(3)
  user       User      @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@index([userId, purpose])
}

enum TokenPurpose { VERIFY RESET }
```

- 256 bits of randomness, delivered once in the link.
- **Stored as SHA-256 only.** A database read must not yield a usable token.
- `VERIFY` lasts 24 hours, `RESET` lasts 1 hour. A reset link is a password in
  disguise and should live for minutes, not days.
- **Consumption is atomic**: `updateMany` guarded on `consumedAt: null` and
  `expiresAt > now`, treating `count === 0` as spent. Check-then-write was a
  real defect in the invite flow and is not repeated here.
- Requesting a new token of a purpose consumes any outstanding one for that
  user and purpose, so an old link in an old inbox stops working.

`User` gains `emailVerifiedAt DateTime? @db.Timestamptz(3)`.

## Endpoints

```
POST /v1/auth/verify/request      authenticated; sends (or resends) a verification mail
POST /v1/auth/verify/confirm      { token } → marks the user verified
POST /v1/auth/password/request    { email } → sends a reset link
POST /v1/auth/password/confirm    { token, password } → sets the password
```

Signup sends the first verification mail automatically; `verify/request` is the
resend button.

**The request endpoints respond identically whether or not the account
exists.** Same status, same body, same timing. Otherwise they become an
account-enumeration oracle — the same posture the 404-not-403 rule takes
everywhere else in this API, and the same reason the login path was equalised
to pay the argon2 cost on an unknown email.

Both request endpoints are rate-limited per IP, keyed on IP only, consistent
with the ruling that keying a limiter on attacker-supplied content lets an
attacker mint unlimited buckets.

**A send failure must not fail the request.** Signup succeeds, the response says
the mail is on its way, and the user can resend. An SMTP hiccup costing someone
their account would be a worse bug than the one this phase fixes.

## The gate

A `requireVerified` preHandler, applied to authenticated **user** routes.

Explicitly **not** applied to:

- `/v1/auth/*` — a user must be able to log in, refresh, log out, and request
  or confirm verification while unverified. Gating these locks everyone out.
- `/v1/ingest` — **this is the important exclusion.** Ingest is authenticated by
  an app's ingest key, not by a user. A customer's data must keep flowing
  regardless of any human's email state; one unverified teammate must not stop
  an app reporting.
- `/healthz`.

Unverified requests to gated routes return **403** with a distinguishable code,
so the dashboard can route to "check your inbox" rather than showing a generic
error.

## Password reset

`password/confirm` sets the new hash and **revokes the user's entire refresh
token family**. The API already implements family revocation for replay, so a
password change invalidating every session comes free — and it is the behaviour
someone resetting a password after a compromise expects.

The new password goes through the same argon2id parameters and the same
strength validation as signup.

## What this phase does not do

- No email delivery for invites. They still hand the token to the caller. That
  is a separate change and the spec's "no email in v1" line covers it.
- No alert or digest email. §7 puts that out of v1.
- No HTML template system. Two mails, each a short text body with a link and a
  minimal HTML part.
- No bounce or complaint handling.

## Testing

Unit, on pure helpers:

- token generation and hashing — a generated token never equals its stored form
- expiry arithmetic for both purposes

Integration, against the real database:

- verify: happy path; expired token; already-consumed token; a token for the
  wrong purpose used on the other endpoint
- reset: happy path sets the hash and revokes every refresh token; expired
  token; reuse of a consumed token
- requesting a new token consumes the previous one of that purpose
- **both request endpoints return byte-identical responses for a known and an
  unknown email**
- the gate: an unverified user gets 403 on a gated route, 2xx on `/v1/auth/*`,
  and **ingest keeps working** with an unverified owner
- a mail transport failure leaves signup successful

Every one of these gets a test that **fails when the guard is removed**. A gate
implemented correctly but pinned by no test was the main finding in six of nine
tasks of the previous plan, and the mitigation is to write the failing case
first, not to remember harder.

The mailer is faked in tests through the single `send()` seam. No test opens an
SMTP connection.

## Build order

1. `VerificationToken` model, `TokenPurpose` enum, `User.emailVerifiedAt`, migration
2. `mailer.ts` and its single `send()` seam, with a fake for tests
3. Token issue and consume helpers, unit tested
4. The four endpoints, with the identical-response property tested
5. `requireVerified` and its exclusions, with the ingest exclusion tested
6. Deploy and verify live against the real SMTP credentials
