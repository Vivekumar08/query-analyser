// @vitest-environment jsdom
import { afterEach, describe, it, expect, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

vi.mock('framer-motion', async (orig) => ({
  ...(await orig<typeof import('framer-motion')>()),
  useReducedMotion: () => true,
}));

import Page from '@/app/page';

const NPM = 'https://www.npmjs.com/package/@vivekumar08/query-analyser';
const GITHUB = 'https://github.com/Vivekumar08/query-analyser';

afterEach(cleanup);

describe('homepage', () => {
  it('leads with the approved headline, eyebrow and lead', () => {
    render(<Page />);
    const h1 = screen.getByRole('heading', { level: 1 });
    expect(h1.textContent).toContain('Your slowest queries,');
    expect(within(h1).getByText('quietly').tagName).toBe('EM');
    expect(screen.getByText('For MongoDB · mongoose 8')).toBeTruthy();
    expect(
      screen.getByText('One line in your app. We group every slow call by shape and tell you which index to add first.'),
    ).toBeTruthy();
  });

  it('links go where the spec says', () => {
    render(<Page />);
    expect(screen.getByRole('link', { name: 'Sign in' }).getAttribute('href')).toBe('/login');
    const keys = screen.getAllByRole('link', { name: /get your key/i });
    expect(keys).toHaveLength(2);
    for (const k of keys) expect(k.getAttribute('href')).toBe('/signup');
    expect(screen.getByRole('link', { name: 'How it works' }).getAttribute('href')).toBe('#how');
    expect(screen.getByRole('link', { name: 'Pricing' }).getAttribute('href')).toBe('#pricing');
    for (const name of ['Docs', 'npm']) {
      for (const a of screen.getAllByRole('link', { name })) {
        expect(a.getAttribute('href')).toBe(NPM);
        expect(a.getAttribute('target')).toBe('_blank');
      }
    }
    const gh = screen.getByRole('link', { name: 'GitHub' });
    expect(gh.getAttribute('href')).toBe(GITHUB);
    expect(gh.getAttribute('target')).toBe('_blank');
  });

  it('has the How it works and Pricing anchors', () => {
    const { container } = render(<Page />);
    const how = container.querySelector('#how')!;
    for (const t of ['Install one line', 'We group by shape', 'Fix what matters first']) expect(how.textContent).toContain(t);
    const pricing = container.querySelector('#pricing')!;
    expect(pricing.textContent).toContain('Free');
    expect(pricing.textContent).toContain('Team');
  });

  it('shows shapes, never values', () => {
    const { container } = render(<Page />);
    expect(container.textContent).toContain("priya@shop.in");
    expect(container.textContent).toContain("'range'");
    expect(screen.getByRole('heading', { name: /never values/i })).toBeTruthy();
    expect(container.textContent).toContain('MIT');
  });

  it('renders everything visible under reduced motion', () => {
    const { container } = render(<Page />);
    const hidden = [...container.querySelectorAll<HTMLElement>('[style]')].filter((el) => el.style.opacity === '0');
    expect(hidden).toHaveLength(0);
  });

  it('imports nothing from auth, session or refresh', () => {
    const root = path.resolve(__dirname, '..');
    const files = [
      path.join(root, 'app/page.tsx'),
      ...readdirSync(path.join(root, 'components/marketing'))
        .filter((f) => f.endsWith('.tsx') && !f.endsWith('.test.tsx'))
        .map((f) => path.join(root, 'components/marketing', f)),
    ];
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      expect(src, f).not.toMatch(/@\/src\/auth|\/session['"]|\/refresh['"]/);
    }
  });
});
