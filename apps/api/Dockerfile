# `argon2` (apps/api's password hasher) is a native addon distributed as
# prebuilt binaries for linux-x64/linux-arm64 (glibc) — there is no
# linux-musl prebuild at all, so `node:22-alpine` would fall through to a
# node-gyp source build that alpine's musl toolchain is not guaranteed to
# produce correctly (and the image ships no python3/make/g++ to even try).
# `node:22-slim` is Debian/glibc, so the existing prebuild is used as-is and
# no native build toolchain needs to be installed anywhere in this file.
FROM node:22-slim AS base
# openssl + ca-certificates: Prisma's CLI wants openssl, and any https fetch
# during install needs the CA bundle, which `slim` does not ship.
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate
WORKDIR /repo

FROM base AS deps
# .npmrc must come along: it sets auto-install-peers=false, which is what
# pnpm-lock.yaml records under `settings`. Without it pnpm falls back to its
# own default (true), the lockfile's settings no longer match, and a frozen
# install refuses to proceed with ERR_PNPM_LOCKFILE_CONFIG_MISMATCH.
COPY .npmrc pnpm-lock.yaml pnpm-workspace.yaml package.json turbo.json tsconfig.base.json ./
COPY packages/contract/package.json packages/contract/
COPY packages/sdk/package.json packages/sdk/
COPY apps/api/package.json apps/api/
# `mongodb-memory-server` is a devDependency used only by the e2e test, and its
# postinstall downloads a MongoDB binary. That download has no business running
# in an image build — it is slow, needs network, and fails the whole install if
# the fetch fails. The tests that need it never run in this image.
ENV MONGOMS_DISABLE_POSTINSTALL=1
RUN pnpm install --frozen-lockfile --filter @query-analyser/api...

FROM deps AS build
COPY packages/contract packages/contract
COPY apps/api apps/api
# prisma.config.ts resolves env('DATABASE_URL') eagerly, so `prisma generate`
# refuses to start without it — even though generation only reads the schema
# and never opens a connection. The real URL is injected at RUN time by the
# platform and must NOT be baked into a layer, so generation gets a throwaway
# value that exists only for the duration of this command.
# `...` builds @query-analyser/api AND its workspace dependencies. The api is
# compiled with plain tsc, so its emitted JS keeps the bare
# '@query-analyser/contract' specifier — that package has to exist as real
# JavaScript at runtime, not as the TypeScript source it used to export.
RUN DATABASE_URL="postgresql://build:build@127.0.0.1:5432/build" \
      pnpm --filter @query-analyser/api db:generate \
  && pnpm --filter "@query-analyser/api..." build

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=build /repo /repo
WORKDIR /repo/apps/api
EXPOSE 8080
CMD ["sh", "-c", "pnpm db:deploy && node dist/server.js"]
