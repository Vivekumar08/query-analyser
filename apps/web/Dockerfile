# Build context is the REPO ROOT, not apps/web:
#   docker build -f apps/web/Dockerfile .
# Ignore rules live in the repo-root .dockerignore — a .dockerignore nested
# beside this file would never be read by `docker build` and would only
# mislead whoever next edits it into thinking they changed the build.
FROM node:22-alpine AS base
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate
WORKDIR /app

FROM base AS deps
# TRAP 1: .npmrc must be copied. The lockfile records `autoInstallPeers: false`
# under `settings:`, and the root .npmrc is where that comes from. Without it
# pnpm computes a different settings hash and --frozen-lockfile refuses the
# lockfile as out of date. This cost a round on the API deploy.
COPY .npmrc package.json pnpm-lock.yaml pnpm-workspace.yaml ./
# TRAP 2: EVERY workspace package.json must be present before install.
# --frozen-lockfile validates the lockfile against the workspace it can see, so
# a missing member makes the lockfile look stale and the install fails. Adding
# a new package to the repo means adding a line here.
COPY apps/web/package.json       apps/web/package.json
COPY apps/api/package.json       apps/api/package.json
COPY packages/contract/package.json packages/contract/package.json
COPY packages/sdk/package.json      packages/sdk/package.json
# apps/api's `mongodb-memory-server` devDependency downloads a MongoDB binary in
# its postinstall. That download has no business in the web image: it is slow,
# needs network, and fails the whole install if the fetch fails. apps/api's own
# Dockerfile guards it the same way, for the same reason.
ENV MONGOMS_DISABLE_POSTINSTALL=1
# Filtered to the web app and its workspace dependencies, so the other members'
# devDependencies are never installed at all. `--frozen-lockfile` still
# validates against the whole workspace, which is why every member's
# package.json must be copied above — that is trap 2 and it still applies.
RUN pnpm install --frozen-lockfile --filter @query-analyser/web...

FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/web/node_modules ./apps/web/node_modules
COPY --from=deps /app/packages/contract/node_modules ./packages/contract/node_modules
COPY . .
# The contract is consumed through its `dist`, which is not committed, so it
# must be built before the web app that imports it.
RUN pnpm --filter @query-analyser/contract build
# This placeholder is pre-emptive: nothing imports env.ts's loadWebEnv yet, so
# next build would succeed without it today. It exists so the build does not
# start failing the moment a later plan wires loadWebEnv into a Server
# Component. When that happens, that component must read API_ORIGIN
# per-request, not at module scope, or this placeholder value gets baked into
# any statically prerendered RSC payload.
ENV API_ORIGIN=https://placeholder.invalid
RUN pnpm --filter @query-analyser/web build

FROM base AS run
ENV NODE_ENV=production
ENV PORT=3000
# Bind on all interfaces, as Next's reference Dockerfile does; Docker's default
# HOSTNAME is the container ID. Hygiene only: redirects never carry this host,
# because route handlers emit relative Locations (Ruling B18).
ENV HOSTNAME=0.0.0.0
# Next's standalone output is a self-contained server: it bundles only the
# node_modules it actually needs, so this stage installs nothing.
COPY --from=build /app/apps/web/.next/standalone ./
COPY --from=build /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=build /app/apps/web/public ./apps/web/public
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
