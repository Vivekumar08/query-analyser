import { defineConfig } from 'tsup';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const pkg = JSON.parse(
  readFileSync(fileURLToPath(new URL('./package.json', import.meta.url)), 'utf8'),
) as { version: string };

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  target: 'node20',
  // The contract is a workspace package and is NOT published — inline it so
  // the published SDK has zero runtime dependencies.
  noExternal: [/@query-analyser\/contract/],
  external: ['mongoose'],
  // Minor fix 7: SDK_VERSION is wired from package.json at build time so it
  // cannot drift from the published version. See src/index.ts.
  define: { __SDK_VERSION__: JSON.stringify(pkg.version) },
});
