import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(__dirname, '..');
const fadeIn = readFileSync(path.join(root, 'app/_components/landing/FadeIn.tsx'), 'utf8');
const css = readFileSync(path.join(root, 'app/globals.css'), 'utf8');

describe('scroll reveal never hides server-rendered content', () => {
  it('FadeIn is a server component with no JS animation runtime', () => {
    expect(fadeIn).not.toMatch(/'use client'/);
    expect(fadeIn).not.toMatch(/framer-motion/);
    expect(fadeIn).toMatch(/reveal/);
  });

  it('the reveal animation only exists for motion-OK browsers that support scroll timelines', () => {
    const block = css.match(/@media \(prefers-reduced-motion: no-preference\)\s*\{([\s\S]*?)\n\}/);
    expect(block).not.toBeNull();
    expect(block![1]).toMatch(/@supports \(animation-timeline: view\(\)\)/);
    expect(block![1]).toMatch(/\.reveal/);
    // Outside that block .reveal must not start hidden.
    const outside = css.replace(block![0], '');
    expect(outside).not.toMatch(/\.reveal\s*\{[^}]*opacity:\s*0/);
  });
});
