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
pnpm --filter @query-analyser/api test
```

Tests run against the real database in `DATABASE_URL` and truncate all tables
between tests. Point it at a throwaway database.

## Build

`pnpm build` at the repo root runs `turbo run build`. For the API package,
turbo runs `db:generate` (`prisma generate`) before `build` (`tsc`), so the
generated Prisma client is always present before the TypeScript compiler needs
its types. See `turbo.json`.

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

**Status of this deploy path:** the Dockerfile and `docker-compose.yml` are
written and reviewed, and `turbo run build` is proven (via
`turbo run build --dry=json`) to generate the Prisma client before compiling
the API. The actual `docker build` / container boot / `/healthz` round trip
has **not** been exercised in this environment (Docker was unavailable), so
treat the container image as unverified until someone runs it end to end
somewhere Docker is available.

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
