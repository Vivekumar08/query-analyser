# Build context is the REPO ROOT, not apps/web:
#   docker build -f apps/web/Dockerfile .
FROM node:22-alpine AS base
RUN corepack enable
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
COPY . .
# NOTE: apps/web does not depend on @query-analyser/contract yet, so nothing
# is built here but the web app itself. When Plan B has the UI import the
# contract's wire types, this stage gains
#   COPY --from=deps /app/packages/contract/node_modules ./packages/contract/node_modules
#   RUN pnpm --filter @query-analyser/contract build
# because the contract is consumed through its `dist`, which is not committed.
# Next needs API_ORIGIN present at build time because env.ts validates it.
# This value is NOT baked into the image for runtime use — the server reads the
# real one from the container environment. It is a placeholder that only has to
# parse as a URL.
ENV API_ORIGIN=https://placeholder.invalid
RUN pnpm --filter @query-analyser/web build

FROM base AS run
ENV NODE_ENV=production
ENV PORT=3000
# Next's standalone output is a self-contained server: it bundles only the
# node_modules it actually needs, so this stage installs nothing.
COPY --from=build /app/apps/web/.next/standalone ./
COPY --from=build /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=build /app/apps/web/public ./apps/web/public
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
