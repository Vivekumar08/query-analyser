import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Mirrors tsconfig.json's `@/*` -> `./*` path alias so tests can import
  // route handlers (which use `@/src/...` imports) directly.
  esbuild: { jsx: 'automatic' },
  resolve: { alias: { '@': path.resolve(__dirname, '.') } },
  test: {
    // node by default; component tests opt into jsdom with a
    // `// @vitest-environment jsdom` first line.
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'components/**/*.test.tsx'],
  },
});
