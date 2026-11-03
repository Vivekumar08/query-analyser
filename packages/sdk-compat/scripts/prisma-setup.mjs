#!/usr/bin/env node
// Installs and generates the Prisma compat fixtures (Task 19).
//
// For each fixture in prisma-fixtures/: `npm install --ignore-scripts --no-audit --no-fund
// --no-package-lock` (each fixture is its own npm project, outside the pnpm workspace), then that
// fixture's own Prisma CLI runs `generate` once per schema file. `generate` never connects, so it
// gets a placeholder DATABASE_URL; no real URL or credential is read or printed here.
// Prints `ready <name> prisma <version>` per fixture. Usage: node scripts/prisma-setup.mjs [name...]
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', 'prisma-fixtures');
const FIXTURES = ['p522', 'p601', 'p619', 'p710', 'p710-private'];
const SCHEMAS = { p522: ['schema.prisma', 'schema.tracing.prisma'], p601: ['schema.prisma', 'schema.tracing.prisma'] };

const env = {
  ...process.env,
  DATABASE_URL: 'postgresql://placeholder@localhost:5432/placeholder',
  CHECKPOINT_DISABLE: '1',
  PRISMA_HIDE_UPDATE_MESSAGE: '1',
  PRISMA_DISABLE_WARNINGS: '1',
};

function run(cmd, args, cwd) {
  const r = spawnSync(cmd, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
  if (r.status !== 0) {
    process.stderr.write(r.stdout ?? '');
    process.stderr.write(r.stderr ?? '');
    throw new Error(`prisma-setup: \`${cmd} ${args.join(' ')}\` failed in ${cwd} (exit ${r.status})`);
  }
}

const wanted = process.argv.slice(2);
for (const name of wanted.length > 0 ? wanted : FIXTURES) {
  if (!FIXTURES.includes(name)) throw new Error(`prisma-setup: unknown fixture ${name}`);
  const dir = join(ROOT, name);
  run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--no-package-lock'], dir);
  const cli = join(dir, 'node_modules', 'prisma', 'build', 'index.js');
  if (!existsSync(cli)) throw new Error(`prisma-setup: ${name} has no prisma CLI after install`);
  for (const schema of SCHEMAS[name] ?? ['schema.prisma']) {
    run(process.execPath, [cli, 'generate', '--schema', schema], dir);
  }
  const { version } = JSON.parse(readFileSync(join(dir, 'node_modules', 'prisma', 'package.json'), 'utf8'));
  console.log(`ready ${name} prisma ${version}`);
}
