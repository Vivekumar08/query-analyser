# query-analyser API

Ingest + auth + tenancy for `@vivekumar08/query-analyser`.

## Run locally

```bash
docker compose up -d postgres
cp apps/api/.env.example apps/api/.env
pnpm --filter @query-analyser/api db:migrate   # first time
pnpm --filter @query-analyser/api db:generate
pnpm --filter @query-analyser/api dev
```

This repo's own development was done against a local Homebrew Postgres at
`postgresql://qa:qa@localhost:5432/qa`; `docker compose up -d postgres` remains
the documented path for anyone without a local Postgres already running — point
`DATABASE_URL` at whichever one you use.

## Test

```bash
docker compose up -d postgres
pnpm --filter @query-analyser/api db:generate   # first time / fresh clone
pnpm --filter @query-analyser/api test
```

`apps/api/src/generated/` (the Prisma client) is gitignored, so a fresh clone
has no client to import until `db:generate` has run at least once — every test
file imports it. `pnpm --filter <pkg> test`/`typecheck` run the package's own
script directly and do **not** go through turbo, so they do not benefit from
`turbo.json`'s `db:generate` dependency below; run `db:generate` yourself
first. Running via turbo instead (`pnpm test` / `pnpm typecheck` at the repo
root, or `turbo run test --filter @query-analyser/api`) generates it for you.

Tests run against the real database in `DATABASE_URL` and truncate all tables
between tests. Point it at a throwaway database.

## Build

`pnpm build` at the repo root runs `turbo run build`. `pnpm test` and
`pnpm typecheck` at the repo root likewise run `turbo run test` /
`turbo run typecheck`. For the API package, turbo runs `db:generate`
(`prisma generate`) before `build`, `test`, and `typecheck`, so the generated
Prisma client is always present before anything that needs its types — a
clean checkout can run `pnpm test` or `pnpm typecheck` at the root with no
manual `db:generate` step. See `turbo.json`.

## Environment variables

| var | purpose |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string |
| `JWT_SECRET` | ≥32 chars; signs 15-minute access tokens |
| `COOKIE_SECRET` | ≥32 chars; signs the refresh cookie |
| `PORT` | default 8080 |
| `LOG_LEVEL` | pino log level, default `info` |
| `TRUST_PROXY` | default **`false`**. See warning below. |
| `NODE_ENV` | `production` makes the refresh cookie `Secure` |
| `WEB_PROXY_SECRET` | optional, ≥32 chars, must equal the web service's value. See below. |

See `apps/api/.env.example` for the full list with defaults.

### `TRUST_PROXY` defaults to false

`TRUST_PROXY` is `false` unless explicitly set. When the API sits behind a
reverse proxy (Easypanel, nginx, a load balancer, etc.) and `TRUST_PROXY` is
left at its default, Fastify will **not** trust `X-Forwarded-For`, so
`req.ip` resolves to the proxy's address rather than the real client's. The
`/v1/ingest` rate limiter keys on IP alone, so every client ends up sharing a
single bucket behind an untrusted proxy — effectively rate-limiting all
tenants together. Set `TRUST_PROXY=true` (or a comma-separated list of
trusted CIDRs/IPs) whenever this service is deployed behind a proxy.

### `WEB_PROXY_SECRET`: per-browser auth rate limits behind the web app

Browsers never call `/v1/auth/*` directly: `apps/web`'s route handlers do,
server to server, so `req.ip` for every login and signup is the web
container's address. With nothing else configured, the per-IP limits (login
20/min, signup 30/min, password request 10/min) are one bucket shared by
every user, and one client sending bad logins locks everyone out.

Set the same random value (≥32 chars, e.g. `openssl rand -hex 32`) as
`WEB_PROXY_SECRET` on **both** the API and the web service. The web app then
sends the browser's IP in `x-qa-client-ip` and the secret in
`x-qa-proxy-secret`; the rate limiter uses the forwarded IP only when the
secret matches (constant-time compare) and the value is a literal IP. Any
other request, including one with a wrong or missing secret, keys on
`req.ip` exactly as before. Unset means unchanged behaviour.

Trust assumption: the web app takes the browser's IP from the **rightmost**
`X-Forwarded-For` entry it receives — the one appended by the proxy directly
in front of it. Entries to its left are client-supplied and are ignored (a
client rotating a fake `X-Forwarded-For` therefore cannot evade the limit).
This assumes **exactly one** trusted proxy hop (EasyPanel's) in front of the
web container: with none, a client's own value would be used; with more than
one, the rightmost entry is the inner proxy. Never expose the secret to the
browser.

### `totalMs` is a string, not a number

Rollup `totalMs` columns (`QueryRollup`, `QueryDailyRollup`) are stored as
Postgres `bigint`. Prisma returns `bigint` as a JS `BigInt`, and the app
installs a BigInt-safe JSON serializer so responses don't throw — but that
means **`totalMs` is serialised as a numeric string in the JSON response**
(e.g. `"totalMs": "12345"`), not a JS `number`. Any dashboard or client
reading rollup responses must `Number(...)` or `BigInt(...)` it explicitly
before doing arithmetic; naive `response.totalMs + 1`-style code will do
string concatenation instead of addition.

## Prisma / migrations

- `prisma.config.ts` carries the datasource URL for the Prisma CLI
  (`prisma generate`, `prisma migrate ...`) by reading `DATABASE_URL` from the
  environment via `dotenv/config`.
- The running application does **not** use that CLI config at runtime. It
  constructs its own `PrismaPg` driver adapter (see `src/plugins/prisma.ts`)
  from `DATABASE_URL`, so no Prisma query-engine binary needs to be present in
  the deployed image.
- Migrations are applied with `prisma migrate deploy` (not `migrate dev`),
  which only applies already-committed migrations and never generates new
  ones. This runs as part of container start (see Deploy, below).

## Deploy (Easypanel / any Docker host)

Build context is the repo root; Dockerfile is `apps/api/Dockerfile`. See the
Environment variables table above for the required vars.

The container's `CMD` runs `pnpm db:deploy` (i.e. `prisma migrate deploy`)
and then starts the server. Put it behind TLS and point
`ingest.query-analyser.dev` (the SDK's default endpoint) at it.

### Email: required vars, operator-assisted verification until `apps/web` exists

Four variables must be set for a deploy's outgoing mail to work: `SMTP_HOST`,
`SMTP_USER`, `SMTP_PASS`, and `WEB_ORIGIN`. None of the four default to
anything — a deploy missing any of them fails at container boot, in
`loadConfig`, naming the missing variable(s) by path, rather than failing
silently later (a swallowed send, or an emailed link pointing at
`localhost`).

There is no web app in this repo yet (`apps/` contains only `api`). Until
`apps/web` exists and serves `/verify` and `/reset-password`, a **new**
signup's email verification is operator-assisted: the token arrives in the
emailed link's query string (`?token=...`), and an operator completes it by
calling `POST /v1/auth/verify/confirm` with `{ "token": "..." }` as the
request body. The same applies to `POST /v1/auth/password/confirm` for a
password reset.

Accounts that existed before this gate shipped were grandfathered by the
backfill migration (`20261011120000_backfill_email_verified_at`) — they do
not need an operator to do anything.

**Status of this deploy path:** verified end to end on 1 Oct 2026 against
EasyPanel (`prod/query-analyser-api`, Postgres 17). The image builds, the
container boots, `prisma migrate deploy` applies all three migrations, and
`GET /healthz` answers `{"status":"ok"}`. A full smoke test — signup, create
org, create app, mint an ingest key, `POST /v1/ingest` -> 202 — landed a row in
`QueryRollup` with its `totalMs` and `hist` intact.

Getting there took five fixes that only a real build surfaces, all now in the
Dockerfile and in `packages/contract`: `.npmrc` must be copied or the frozen
install rejects the lockfile's `autoInstallPeers`; `mongodb-memory-server`'s
postinstall must be disabled; `openssl`/`ca-certificates` must be installed on
`slim`; `prisma generate` needs a throwaway `DATABASE_URL` that must not be
baked into a layer; and `@query-analyser/contract` has to emit real JavaScript,
because the API compiles with plain `tsc` and keeps the bare specifier.

## Routes

See `docs/superpowers/specs/2026-09-20-query-analyser-design.md` §5.
Everything under `/v1/orgs`, `/v1/apps` requires
`Authorization: Bearer <access token>`; `/v1/ingest` requires an ingest key;
`/v1/admin/*` requires `isPlatformAdmin` (set directly in the database for
now).

## First platform admin

```sql
UPDATE "User" SET "isPlatformAdmin" = true WHERE email = 'you@example.com';
```
