import { describe, it, expect, vi } from 'vitest';
import { ORPHAN_NAME, isLocalPgUrl, pidAlive, shouldSweep, sweepOrphans } from './pg-db.js';

// Unit tests only: the database path is injected, so nothing here connects to Postgres.
const errno = (code: string) => Object.assign(new Error(code), { code });
const deadKill = () => { throw errno('ESRCH'); };
const aliveKill = () => true;
const LOCAL = 'postgresql://u:p@localhost:5432/qa';
const SELF = 4242;

describe('ORPHAN_NAME', () => {
  it('matches only qa_sdk_<prefix>_<pid>_<6 hex> and captures the pid', () => {
    expect(ORPHAN_NAME.exec('qa_sdk_compat_pg823_12345_a1b2c3')?.[1]).toBe('12345');
    expect(ORPHAN_NAME.exec('qa_sdk_prisma_p710_77_00ff00')?.[1]).toBe('77');
    for (const n of ['qa', 'qa_sdk_x_1_abc', 'qa_sdk_x_1_ABCDEF', 'qa_sdk__1_abcdef', 'other_x_1_abcdef', 'qa_sdk_x_1_abcdef_y', 'qa_sdk_x_y_abcdef']) {
      expect(ORPHAN_NAME.test(n)).toBe(false);
    }
  });
});

describe('isLocalPgUrl', () => {
  it('is true for localhost, 127.0.0.1, ::1 and a Unix socket', () => {
    for (const u of [LOCAL, 'postgres://127.0.0.1/qa', 'postgresql://[::1]:5432/qa', 'postgresql:///qa?host=/tmp', 'postgresql://%2Ftmp/qa', 'postgresql://LOCALHOST/qa']) {
      expect(isLocalPgUrl(u)).toBe(true);
    }
  });
  it('is false for any other host, or an unreadable URL', () => {
    for (const u of ['postgresql://db.example.com/qa', 'postgresql://10.0.0.5/qa', 'postgresql://localhost.evil.io/qa', 'not a url', '']) {
      expect(isLocalPgUrl(u)).toBe(false);
    }
  });
});

describe('pidAlive', () => {
  it('ESRCH is dead; success and EPERM (someone else\'s live process) are alive; other errors count as alive', () => {
    expect(pidAlive(1, deadKill)).toBe(false);
    expect(pidAlive(1, aliveKill)).toBe(true);
    expect(pidAlive(1, () => { throw errno('EPERM'); })).toBe(true);
    expect(pidAlive(1, () => { throw new Error('x'); })).toBe(true);
  });
  it('signals 0 only', () => {
    const kill = vi.fn(() => true);
    pidAlive(99, kill);
    expect(kill).toHaveBeenCalledWith(99, 0);
  });
});

describe('shouldSweep', () => {
  const at = (name: string, over: Partial<Parameters<typeof shouldSweep>[1]> = {}) =>
    shouldSweep(name, { selfPid: SELF, baseUrl: LOCAL, kill: deadKill, ...over });

  it('sweeps a matching database whose pid is dead, on a local host', () => {
    expect(at('qa_sdk_compat_pg823_12345_a1b2c3')).toBe(true);
  });
  it('never sweeps its own pid', () => {
    expect(at(`qa_sdk_compat_pg823_${SELF}_a1b2c3`)).toBe(false);
  });
  it('never sweeps a live pid (alive or EPERM)', () => {
    expect(at('qa_sdk_compat_pg823_12345_a1b2c3', { kill: aliveKill })).toBe(false);
    expect(at('qa_sdk_compat_pg823_12345_a1b2c3', { kill: () => { throw errno('EPERM'); } })).toBe(false);
  });
  it('never sweeps on a remote host', () => {
    expect(at('qa_sdk_compat_pg823_12345_a1b2c3', { baseUrl: 'postgresql://db.example.com/qa' })).toBe(false);
  });
  it('never sweeps a name that does not match, including qa', () => {
    for (const n of ['qa', 'qa_sdk', 'postgres', 'qa_sdk_compat_12345', 'qa_sdk_x_12345_zzzzzz']) expect(at(n)).toBe(false);
  });
});

describe('sweepOrphans', () => {
  it('drops only the orphans, with a plain DROP DATABASE IF EXISTS (no FORCE)', async () => {
    const names = ['qa', 'postgres', 'qa_sdk_a_111_aaaaaa', 'qa_sdk_b_222_bbbbbb', `qa_sdk_c_${SELF}_cccccc`];
    const sql: string[] = [];
    const dropped = await sweepOrphans({
      baseUrl: LOCAL, selfPid: SELF, kill: (pid: number) => { if (pid === 222) return true; throw errno('ESRCH'); },
      list: async () => names, exec: async (q: string) => { sql.push(q); },
    });
    expect(dropped).toEqual(['qa_sdk_a_111_aaaaaa']);
    expect(sql).toEqual(['DROP DATABASE IF EXISTS "qa_sdk_a_111_aaaaaa"']);
  });

  it('does not even list databases on a remote host', async () => {
    const list = vi.fn(async () => ['qa_sdk_a_111_aaaaaa']); const exec = vi.fn(async () => {});
    expect(await sweepOrphans({ baseUrl: 'postgresql://db.example.com/qa', selfPid: SELF, kill: deadKill, list, exec })).toEqual([]);
    expect(list).not.toHaveBeenCalled();
    expect(exec).not.toHaveBeenCalled();
  });

  it('a failed drop (still in use) is skipped and the rest continue; it never throws', async () => {
    const exec = vi.fn(async (q: string) => { if (q.includes('111')) throw errno('55006'); });
    const dropped = await sweepOrphans({
      baseUrl: LOCAL, selfPid: SELF, kill: deadKill, list: async () => ['qa_sdk_a_111_aaaaaa', 'qa_sdk_b_222_bbbbbb'], exec,
    });
    expect(dropped).toEqual(['qa_sdk_b_222_bbbbbb']);
    await expect(sweepOrphans({ baseUrl: LOCAL, selfPid: SELF, kill: deadKill, list: async () => { throw new Error('down'); }, exec })).resolves.toEqual([]);
  });
});
