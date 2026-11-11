import { defineConfig } from 'vitest/config';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// The compat tests import the SDK source directly, so mirror the SDK's own
// `define` and SDK_VERSION is the real package.json version here too.
const sdkPkg = JSON.parse(
  readFileSync(fileURLToPath(new URL('../sdk/package.json', import.meta.url)), 'utf8'),
) as { version: string };

export default defineConfig({
  define: { __SDK_VERSION__: JSON.stringify(sdkPkg.version) },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    testTimeout: 120_000,
    fileParallelism: false,
  },
});
