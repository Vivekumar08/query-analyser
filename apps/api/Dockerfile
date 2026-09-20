FROM node:22-alpine AS base
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate
WORKDIR /repo

FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json turbo.json tsconfig.base.json ./
COPY packages/contract/package.json packages/contract/
COPY apps/api/package.json apps/api/
RUN pnpm install --frozen-lockfile --filter @query-analyser/api...

FROM deps AS build
COPY packages/contract packages/contract
COPY apps/api apps/api
RUN pnpm --filter @query-analyser/api db:generate && pnpm --filter @query-analyser/api build

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=build /repo /repo
WORKDIR /repo/apps/api
EXPOSE 8080
CMD ["sh", "-c", "pnpm db:deploy && node dist/server.js"]
