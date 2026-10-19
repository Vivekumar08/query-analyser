/**
 * Passphrase rules for the sample key. Pure and browser-only in practice: the
 * passphrase is checked here, then handed straight to the in-browser wrap and
 * never sent anywhere.
 */

export const MIN_PASSPHRASE_LENGTH = 12;

/** Characters, not UTF-16 code units, so an emoji counts once. */
const length = (p: string): number => [...p].length;

/** Why the pair can't be used yet, or null when it can. */
export function passphraseIssue(passphrase: string, confirm: string): string | null {
  if (length(passphrase) < MIN_PASSPHRASE_LENGTH) return `Use at least ${MIN_PASSPHRASE_LENGTH} characters.`;
  if (passphrase !== confirm) return "The passphrases don't match.";
  return null;
}

export type PassphraseStrength = 'weak' | 'fair' | 'strong';

/** A rough hint only (length and character variety); it never blocks. */
export function passphraseStrength(passphrase: string): PassphraseStrength {
  const n = length(passphrase);
  if (n < MIN_PASSPHRASE_LENGTH) return 'weak';
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((re) => re.test(passphrase)).length;
  const score = (n >= 16 ? 1 : 0) + (n >= 24 ? 1 : 0) + (classes >= 2 ? 1 : 0) + (classes >= 3 ? 1 : 0);
  return score >= 4 ? 'strong' : score >= 2 ? 'fair' : 'weak';
}
