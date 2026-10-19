import { describe, it, expect } from 'vitest';
import { MIN_PASSPHRASE_LENGTH, passphraseIssue, passphraseStrength } from './passphrase';

describe('passphraseIssue', () => {
  it('requires at least 12 characters', () => {
    expect(MIN_PASSPHRASE_LENGTH).toBe(12);
    expect(passphraseIssue('short pass1', 'short pass1')).toMatch(/12 characters/);
    expect(passphraseIssue('', '')).toMatch(/12 characters/);
  });
  it('counts characters, not UTF-16 code units', () => {
    // 11 emoji are 22 code units but only 11 characters.
    const p = '🔑'.repeat(11);
    expect(passphraseIssue(p, p)).toMatch(/12 characters/);
  });
  it('a mismatch is an issue', () => {
    expect(passphraseIssue('correct horse battery', 'correct horse battery!')).toMatch(/don.t match/);
  });
  it('a good, matching pair has no issue', () => {
    expect(passphraseIssue('correct horse battery', 'correct horse battery')).toBeNull();
  });
});

describe('passphraseStrength', () => {
  it('rates longer, more varied passphrases higher', () => {
    expect(passphraseStrength('aaaaaaaaaaaa')).toBe('weak');
    expect(passphraseStrength('correct horse battery')).toBe('fair');
    expect(passphraseStrength('Correct horse battery staple 42!')).toBe('strong');
  });
});
