// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { InstallStep } from './InstallStep';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ lastSeenAt: null }))));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('InstallStep', () => {
  it('shows the one-time key notice and the key in the snippet', () => {
    render(<InstallStep appId="a1" appName="svc" ingestKey="qa_secret" doneHref="/dashboard/acme/a1/queries" />);
    expect(screen.getByText(/shown once/i)).toBeTruthy();
    expect(screen.getByText(/qa_secret/)).toBeTruthy();
  });
  it('without a key in memory shows "already shown" and no key', () => {
    render(<InstallStep appId="a1" appName="svc" ingestKey={null} doneHref="/x" />);
    expect(screen.getByText(/already shown/i)).toBeTruthy();
    expect(screen.queryByText(/qa_/)).toBeNull();
  });
  it('leaving before copying asks for confirmation', () => {
    render(<InstallStep appId="a1" appName="svc" ingestKey="qa_secret" doneHref="/x" />);
    fireEvent.click(screen.getByRole('button', { name: /skip|go to/i }));
    expect(screen.getByText(/haven.t copied your key/i)).toBeTruthy();
  });
});
