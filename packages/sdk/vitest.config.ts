import { defineConfig } from 'vitest/config';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const pkg = JSON.parse(
  readFileSync(fileURLToPath(new URL('./package.json', import.meta.url)), 'utf8'),
) as { version: string };

export default defineConfig({
  // Minor fix 7: mirror tsup's `define` so SDK_VERSION under test is the
  // real package.json version too, not the '0.0.0' fallback.
  define: { __SDK_VERSION__: JSON.stringify(pkg.version) },
  test: { environment: 'node', include: ['src/**/*.test.ts'], passWithNoTests: true, testTimeout: 60000 },
});
