# query-analyser SDK

Source for [`@vivekumar08/query-analyser`](https://www.npmjs.com/package/@vivekumar08/query-analyser):
find your slow MongoDB and PostgreSQL queries with one line of setup.
Usage docs live in [`packages/sdk/README.md`](packages/sdk/README.md).

## Layout

| Path | What |
|---|---|
| `packages/sdk` | The published SDK (zero runtime dependencies). |
| `packages/contract` | Ingest wire protocol (schema, histogram bounds, sample encryption). Private; inlined into the SDK build. |
| `packages/sdk-compat` | Compatibility suites across Mongoose 5.13–9, mongodb 4–7, pg 8 and Prisma 5.22–7. |

## Develop

Requires Node 20+ and pnpm 9.

```bash
pnpm install
docker compose up -d                 # Postgres for the pg/Prisma tests
cp .env.example .env                 # QA_PG_URL
pnpm --filter @query-analyser/sdk-compat prisma:setup   # once per clone
pnpm build && pnpm typecheck && pnpm test
```

Benchmarks: `pnpm --filter @query-analyser/sdk-compat bench`.

## Release

`cd packages/sdk && pnpm publish` (`prepublishOnly` builds, typechecks and tests).
Deploy the matching API before publishing a version that sends new wire fields.

## License

MIT
