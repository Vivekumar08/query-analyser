// apps/web/src/upstream-errors.test.ts
import { describe, it, expect } from 'vitest';
import { safeUpstreamMessage } from './upstream-errors';

describe('safeUpstreamMessage', () => {
  it('409 maps to message (app)', () => expect(safeUpstreamMessage(409, 'app')).toMatch(/already exists/));
  it('409 maps to message (org)', () => expect(safeUpstreamMessage(409, 'org')).toMatch(/taken/));
  it('429', () => expect(safeUpstreamMessage(429, 'generic')).toMatch(/Too many/));
  it('unknown status is generic, never echoes anything', () => expect(safeUpstreamMessage(502, 'app')).toBe('Something went wrong. Please try again.'));
});
