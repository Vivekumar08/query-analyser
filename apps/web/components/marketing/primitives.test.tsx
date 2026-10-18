// @vitest-environment jsdom
import { afterEach, describe, it, expect } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { Accent } from './Accent';
import { Eyebrow } from './Eyebrow';
import { ExternalLink } from './ExternalLink';
import { GlassCard } from './GlassCard';
import { PillLink } from './PillLink';
import { ProductPreview } from './ProductPreview';

afterEach(cleanup);

describe('marketing primitives', () => {
  it('Accent renders an italic serif em', () => {
    render(<p>found <Accent>quietly</Accent></p>);
    const em = screen.getByText('quietly');
    expect(em.tagName).toBe('EM');
    expect(em.className).toMatch(/font-serif/);
  });

  it('Eyebrow uses the accent text colour', () => {
    render(<Eyebrow>For MongoDB</Eyebrow>);
    expect(screen.getByText('For MongoDB').className).toMatch(/text-accent-text/);
  });

  it('ExternalLink opens in a new tab without leaking the opener', () => {
    render(<ExternalLink href="https://example.com">npm</ExternalLink>);
    const a = screen.getByRole('link', { name: 'npm' });
    expect(a.getAttribute('target')).toBe('_blank');
    expect(a.getAttribute('rel')).toMatch(/noopener/);
    expect(a.getAttribute('rel')).toMatch(/noreferrer/);
  });

  it('PillLink is a rounded-full link to its href', () => {
    render(<PillLink href="/signup">Get your key →</PillLink>);
    const a = screen.getByRole('link', { name: /get your key/i });
    expect(a.getAttribute('href')).toBe('/signup');
    expect(a.className).toMatch(/rounded-full/);
  });

  it('GlassCard picks glass or glass-strong', () => {
    const { container, rerender } = render(<GlassCard>x</GlassCard>);
    expect(container.firstElementChild!.className).toMatch(/\bglass\b/);
    rerender(<GlassCard strong>x</GlassCard>);
    expect(container.firstElementChild!.className).toMatch(/\bglass-strong\b/);
  });

  it('ProductPreview shows the illustrative ranking and an index suggestion', () => {
    const { container } = render(<ProductPreview />);
    const text = container.textContent ?? '';
    for (const s of ['Time wasted', 'Order', '.find', '4.2s', 'createIndex']) expect(text).toContain(s);
  });
});
