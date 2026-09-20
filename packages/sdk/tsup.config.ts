import { defineConfig } from 'tsup';

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
});
