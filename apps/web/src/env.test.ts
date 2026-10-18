import { describe, it, expect } from 'vitest';
import { loadWebEnv } from './env';

const valid = { API_ORIGIN: 'https://api.example.com' };

describe('loadWebEnv', () => {
  it('returns the origin when it is a valid absolute URL', () => {
    expect(loadWebEnv(valid)).toEqual({ API_ORIGIN: 'https://api.example.com' });
  });

  it('throws naming the variable when it is missing', () => {
    // Asserts the SPECIFIC message, not just that API_ORIGIN appears somewhere:
    // `new URL(undefined)` also throws a message containing "API_ORIGIN", so a
    // looser regex passes even with the `if (!raw)` guard deleted — which made
    // this test decoration rather than a gate.
    expect(() => loadWebEnv({})).toThrow(/API_ORIGIN is required/);
  });

  it('throws when it is not an absolute URL', () => {
    // A relative value would silently resolve against whatever origin the
    // server happens to be on, which is exactly the bug the path-routed
    // domain exists to make impossible to hit by accident.
    expect(() => loadWebEnv({ API_ORIGIN: '/v1' })).toThrow(/must be an absolute URL/);
  });

  it('strips a trailing slash so callers can concatenate paths safely', () => {
    // Without this, `${API_ORIGIN}/v1/me` becomes `https://x//v1/me`.
    expect(loadWebEnv({ API_ORIGIN: 'https://api.example.com/' }).API_ORIGIN).toBe(
      'https://api.example.com',
    );
  });

  it('throws on a parseable URL whose protocol is not http(s)', () => {
    // `ftp://x` parses cleanly, so it never reaches the catch block — only the
    // explicit protocol check stops it. Without this test that check is
    // unpinned and a future simplification could delete it silently.
    expect(() => loadWebEnv({ API_ORIGIN: 'ftp://files.example.com' })).toThrow(
      /must be http\(s\)/,
    );
  });
});
