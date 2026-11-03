import { sweepOrphanDbs } from '../../sdk/src/__tests__/pg-db.js';

/**
 * Before any compat suite: drop `qa_sdk_…` databases left by an earlier run that died before its
 * afterAll (dead pid, local Postgres only; see `shouldSweep`). Never fails the run.
 * Set QA_SKIP_ORPHAN_SWEEP=1 to leave them alone.
 */
export default async function setup(): Promise<void> {
  if (process.env.QA_SKIP_ORPHAN_SWEEP === '1') return;
  const dropped = await sweepOrphanDbs();
  if (dropped.length > 0) console.log(`sdk-compat: dropped ${dropped.length} orphaned test database(s): ${dropped.join(', ')}`);
}
