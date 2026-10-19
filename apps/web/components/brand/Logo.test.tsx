// @vitest-environment jsdom
import { afterEach, describe, it, expect } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';
import { LogoMark, Wordmark } from './Logo';

afterEach(cleanup);

describe('LogoMark', () => {
  it('is a labelled image when standalone, decorative inside a wordmark', () => {
    render(<LogoMark size={64} />);
    expect(screen.getByRole('img', { name: 'query·analyser' })).toBeTruthy();
    const { container } = render(<LogoMark size={24} decorative />);
    expect(container.querySelector('svg')!.getAttribute('aria-hidden')).toBe('true');
  });

  it('draws the ◐ cap at large sizes, a solid dot at medium, and three bold spans at 16 px', () => {
    const large = render(<LogoMark size={64} />).container;
    expect(large.querySelector('[data-part="cap-half"]')).not.toBeNull();
    cleanup();
    const medium = render(<LogoMark size={32} />).container;
    expect(medium.querySelector('[data-part="cap-half"]')).toBeNull();
    expect(medium.querySelector('[data-part="cap-dot"]')).not.toBeNull();
    cleanup();
    const small = render(<LogoMark size={16} />).container;
    expect(small.querySelectorAll('[data-part="span"]').length).toBe(3);
    expect(small.querySelector('[data-part^="cap"]')).toBeNull();
  });

  it('uses a lifted tile on dark backgrounds', () => {
    const { container } = render(<LogoMark size={32} tone="dark" />);
    expect(container.querySelector('[data-part="tile"]')!.getAttribute('fill')).toBe('#343A5C');
  });
});

describe('Wordmark', () => {
  it('links home with the product name as its accessible name', () => {
    render(<Wordmark />);
    const link = screen.getByRole('link', { name: /query·analyser/ });
    expect(link.getAttribute('href')).toBe('/');
    expect(link.querySelector('svg')).not.toBeNull();
  });
});

describe('brand rollout', () => {
  const web = path.resolve(__dirname, '../..');

  it('no page still uses the old ◐ text glyph as the logo', () => {
    const walk = (dir: string): string[] =>
      readdirSync(dir).flatMap((f) => {
        const p = path.join(dir, f);
        return statSync(p).isDirectory() ? walk(p) : p.endsWith('.tsx') && !p.endsWith('.test.tsx') ? [p] : [];
      });
    for (const f of [...walk(path.join(web, 'app')), ...walk(path.join(web, 'components'))]) {
      expect(readFileSync(f, 'utf8'), f).not.toMatch(/>◐</);
    }
  });

  it('ships the favicon, svg icon and apple touch icon as Next metadata files', () => {
    for (const f of ['favicon.ico', 'icon.svg', 'apple-icon.png']) {
      expect(existsSync(path.join(web, 'app', f)), f).toBe(true);
    }
    const ico = readFileSync(path.join(web, 'app', 'favicon.ico'));
    expect(ico.readUInt16LE(2)).toBe(1); // ICO type
    expect(ico.readUInt16LE(4)).toBeGreaterThanOrEqual(3); // 16, 32, 48
    const png = readFileSync(path.join(web, 'app', 'apple-icon.png'));
    expect(png.readUInt32BE(16)).toBe(180);
    expect(readFileSync(path.join(web, 'app', 'icon.svg'), 'utf8')).toMatch(/^<svg[^>]+viewBox="0 0 64 64"/);
  });
});
