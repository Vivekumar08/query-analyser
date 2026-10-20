// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { cleanup, render, screen, fireEvent } from '@testing-library/react';
import { PasswordCard } from './PasswordCard';

let fetchMock: ReturnType<typeof vi.fn>;
const reply = (status: number, body?: unknown) => ({ ok: status < 300, status, json: async () => body ?? {} });

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const input = (label: string) => screen.getByLabelText(label) as HTMLInputElement;
function fill(current: string, next: string, confirm: string) {
  fireEvent.change(input('Current password'), { target: { value: current } });
  fireEvent.change(input('New password'), { target: { value: next } });
  fireEvent.change(input('Confirm new password'), { target: { value: confirm } });
  fireEvent.click(screen.getByRole('button', { name: 'Change password' }));
}

describe('PasswordCard', () => {
  it('says other devices sign out within 15 minutes', () => {
    render(<PasswordCard />);
    expect(screen.getByText('Other devices are signed out within 15 minutes.')).toBeTruthy();
  });

  it('uses password inputs with the right autocomplete hints', () => {
    render(<PasswordCard />);
    expect(input('Current password').type).toBe('password');
    expect(input('Current password').autocomplete).toBe('current-password');
    expect(input('New password').autocomplete).toBe('new-password');
    expect(input('Confirm new password').autocomplete).toBe('new-password');
  });

  it.each([
    ['short', 'short', 'Use at least 12 characters.'],
    ['new-password-12', 'new-password-13', "The new passwords don't match."],
  ])('validates locally before sending (%s)', async (next, confirm, message) => {
    render(<PasswordCard />);
    fill('old-password-1', next, confirm);
    expect((await screen.findByRole('alert')).textContent).toBe(message);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses a new password equal to the current one', async () => {
    render(<PasswordCard />);
    fill('old-password-12', 'old-password-12', 'old-password-12');
    expect((await screen.findByRole('alert')).textContent).toBe('Choose a password different from your current one.');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('posts the change and clears the fields on success', async () => {
    fetchMock.mockResolvedValueOnce(reply(200, { ok: true }));
    render(<PasswordCard />);
    fill('old-password-1', 'new-password-12', 'new-password-12');

    expect((await screen.findByRole('status')).textContent).toBe('Password changed.');
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/me/password');
    expect(init.method).toBe('POST');
    expect(new Headers(init.headers).get('content-type')).toBe('application/json');
    expect(JSON.parse(init.body)).toEqual({ currentPassword: 'old-password-1', newPassword: 'new-password-12' });
    for (const label of ['Current password', 'New password', 'Confirm new password']) expect(input(label).value).toBe('');
  });

  it('shows a wrong current password from the BFF', async () => {
    fetchMock.mockResolvedValueOnce(reply(403, { error: 'Your current password is incorrect.' }));
    render(<PasswordCard />);
    fill('wrong-password', 'new-password-12', 'new-password-12');
    expect((await screen.findByRole('alert')).textContent).toBe('Your current password is incorrect.');
    expect(screen.queryByRole('status')).toBeNull();
    expect(input('Current password').value).toBe('wrong-password');
  });
});
