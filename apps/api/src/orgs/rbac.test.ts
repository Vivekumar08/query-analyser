import { describe, it, expect } from 'vitest';
import { roleAtLeast } from './rbac.js';

describe('roleAtLeast', () => {
  it('orders OWNER > ADMIN > MEMBER > VIEWER', () => {
    expect(roleAtLeast('OWNER', 'VIEWER')).toBe(true);
    expect(roleAtLeast('ADMIN', 'MEMBER')).toBe(true);
    expect(roleAtLeast('MEMBER', 'ADMIN')).toBe(false);
    expect(roleAtLeast('VIEWER', 'VIEWER')).toBe(true);
    expect(roleAtLeast('VIEWER', 'MEMBER')).toBe(false);
  });
});
