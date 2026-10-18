// @vitest-environment jsdom
import { afterEach, describe, it, expect } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { Sidebar } from '@/components/dashboard/Sidebar';
import { StatCard } from '@/components/dashboard/StatCard';
import { QueriesTable } from '@/components/dashboard/QueriesTable';

afterEach(cleanup);

const row = {
  hash: 'h1', title: 'Order.find', signature: '{ a: eq }', count: 3, wasted: '4s', wastedShare: 1,
  avg: '1s', p95: { value: 900, basis: 'interpolated' as const }, max: '2s',
};

describe('dashboard wears Mist', () => {
  it('sidebar is strong glass', () => {
    const { container } = render(<Sidebar switcher={null} nav={null} footer={null} />);
    expect(container.querySelector('aside')!.className).toMatch(/\bglass-strong\b/);
  });

  it('stat cards are strong glass', () => {
    const { container } = render(<StatCard label="Calls">12</StatCard>);
    expect(container.querySelector('.glass-strong')).not.toBeNull();
  });

  it('share bars use the chart periwinkle, not ink', () => {
    const { container } = render(<QueriesTable base="/d/a/b" search="" rows={[row]} />);
    expect(container.querySelector('.bg-chart-1')).not.toBeNull();
  });

  it('no dashboard, onboarding or settings text uses the chart periwinkle', () => {
    for (const dir of ['components/dashboard', 'components/onboarding', 'components/settings']) {
      const abs = path.resolve(__dirname, '..', dir);
      for (const f of readdirSync(abs).filter((x) => x.endsWith('.tsx'))) {
        const src = readFileSync(path.join(abs, f), 'utf8');
        expect(src, `${dir}/${f}`).not.toMatch(/text-chart-1|text-\[#7C83D6\]/i);
      }
    }
  });

  it('accent highlights in dashboard/onboarding use periwinkle tokens, not the ink primary', () => {
    for (const f of ['components/dashboard/QueriesTable.tsx', 'components/onboarding/InstallStep.tsx', 'components/onboarding/OnboardingFlow.tsx', 'components/settings/SampleKeySection.tsx', 'components/dashboard/CompassQuery.tsx', 'components/dashboard/RevealValues.tsx']) {
      const src = readFileSync(path.resolve(__dirname, '..', f), 'utf8');
      expect(src, f).not.toMatch(/\b(bg|border|text)-primary\b(?![-/])/);
    }
  });
});

describe('Mist consistency regressions (final review)', () => {
  it('LogoutButton uses Mist styling, not the C1 slate square', () => {
    const src = readFileSync(path.resolve(__dirname, '../app/_components/LogoutButton.tsx'), 'utf8');
    expect(src).not.toMatch(/slate|rounded-md/);
    expect(src).toMatch(/rounded-full/);
  });

  it('the hero copy button keeps a descriptive accessible name', () => {
    const src = readFileSync(path.resolve(__dirname, '../app/page.tsx'), 'utf8');
    expect(src).not.toMatch(/label="Copy"/);
  });
});
