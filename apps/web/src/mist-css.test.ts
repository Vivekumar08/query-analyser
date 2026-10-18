import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { MIST } from './mist-tokens';

const css = readFileSync(path.resolve(__dirname, '../app/globals.css'), 'utf8');

describe('globals.css carries the Mist tokens', () => {
  for (const [name, value] of Object.entries(MIST)) {
    if (typeof value !== 'string') continue;
    it(`contains ${name} (${value})`, () => expect(css.toLowerCase()).toContain(value.toLowerCase()));
  }

  it('defines .glass and .glass-strong', () => {
    expect(css).toMatch(/\.glass\s*\{/);
    expect(css).toMatch(/\.glass-strong\s*\{/);
  });

  it('falls back to a solid surface where backdrop-filter is unsupported', () => {
    const block = css.match(/@supports not \(backdrop-filter[^{]*\{([\s\S]*?)\n\}/);
    expect(block).not.toBeNull();
    expect(block![1]).toMatch(/\.glass[\s\S]*background/);
    expect(block![1]).toMatch(/\.glass-strong/);
  });

  it('paints the haze on body', () => {
    const body = css.match(/body\s*\{([^}]*)\}/g)?.join('\n') ?? '';
    expect(body).toMatch(/radial-gradient/);
  });
});
