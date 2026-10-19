// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { cleanup, render, screen, fireEvent } from '@testing-library/react';

const router = vi.hoisted(() => ({ refresh: vi.fn(), push: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => router }));

import { ProfileCard } from './ProfileCard';

let fetchMock: ReturnType<typeof vi.fn>;
const reply = (status: number, body?: unknown) => ({ ok: status < 300, status, json: async () => body ?? {} });

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  router.refresh.mockReset();
  router.push.mockReset();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('ProfileCard', () => {
  it('saves a trimmed name via PATCH /api/me and announces it', async () => {
    fetchMock.mockResolvedValueOnce(reply(200, { name: 'Grace' }));
    render(<ProfileCard name="Ada" email="ada@x.co" verified />);
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: '  Grace ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect((await screen.findByRole('status')).textContent).toMatch(/Saved/);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/me');
    expect(init.method).toBe('PATCH');
    expect(init.body).toBe('{"name":"Grace"}');
    expect(new Headers(init.headers).get('content-type')).toBe('application/json');
    expect(router.refresh).toHaveBeenCalled();
  });

  it('shows the email read-only with its verified badge', () => {
    render(<ProfileCard name="Ada" email="ada@x.co" verified />);
    expect(screen.getByText('ada@x.co')).toBeTruthy();
    for (const box of screen.getAllByRole('textbox')) expect((box as HTMLInputElement).value).not.toBe('ada@x.co');
    expect(screen.getByText('Verified')).toBeTruthy();
  });

  it('says "Not verified" for an unverified email', () => {
    render(<ProfileCard name="Ada" email="ada@x.co" verified={false} />);
    expect(screen.getByText('Not verified')).toBeTruthy();
  });

  it('shows the BFF error in an alert', async () => {
    fetchMock.mockResolvedValueOnce(reply(400, { error: 'Enter a name between 1 and 100 characters.' }));
    render(<ProfileCard name="Ada" email="ada@x.co" verified />);
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect((await screen.findByRole('alert')).textContent).toBe('Enter a name between 1 and 100 characters.');
    expect(screen.queryByRole('status')).toBeNull();
    expect(router.refresh).not.toHaveBeenCalled();
  });

  it('refuses a blank name without calling the BFF', async () => {
    render(<ProfileCard name="Ada" email="ada@x.co" verified />);
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: '   ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect((await screen.findByRole('alert')).textContent).toBe('Enter a name between 1 and 100 characters.');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('caps the name input at 100 characters', () => {
    render(<ProfileCard name="Ada" email="ada@x.co" verified />);
    expect((screen.getByLabelText('Name') as HTMLInputElement).maxLength).toBe(100);
  });
});
