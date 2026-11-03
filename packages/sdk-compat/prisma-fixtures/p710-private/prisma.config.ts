// Prisma 7 reads the datasource URL from here (the schema has none). DATABASE_URL comes from the
// environment: the compat harness sets it for `db push`, and prisma-setup.mjs sets a placeholder
// for `generate`, which never connects.
import { defineConfig, env } from 'prisma/config';

export default defineConfig({
  schema: 'schema.prisma',
  datasource: { url: env('DATABASE_URL') },
});
