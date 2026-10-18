import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Mirrors tsconfig.json's `@/*` -> `./*` path alias so tests can import
  // route handlers (which use `@/src/...` imports) directly.
  resolve: { alias: { '@': path.resolve(__dirname, '.') } },
  test: { environment: 'node', include: ['src/**/*.test.ts'] },
});
