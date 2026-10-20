// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { cleanup, render, screen, fireEvent, within } from '@testing-library/react';

const router = vi.hoisted(() => ({ replace: vi.fn(), refresh: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => router }));

import { DeleteApp } from './DeleteApp';

let fetchMock: ReturnType<typeof vi.fn>;
const reply = (status: number, body?: unknown) => ({ ok: status < 300, status, json: async () => body ?? {} });

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  router.replace.mockClear();
  router.refresh.mockClear();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function open() {
  render(<DeleteApp appId="app1" appName="Shop" orgSlug="acme" />);
  fireEvent.click(screen.getByRole('button', { name: 'Delete app' }));
  const dialog = screen.getByRole('alertdialog');
  return { dialog, confirm: within(dialog).getByRole('button', { name: 'Delete app' }) as HTMLButtonElement };
}

describe('DeleteApp', () => {
  it('shows the Danger zone heading and the dialog copy', () => {
    const { dialog } = open();
    expect(screen.getByRole('heading', { name: 'Danger zone', hidden: true })).toBeTruthy();
    expect(within(dialog).getByText('Delete Shop?')).toBeTruthy();
    expect(within(dialog).getByText("This deletes its keys, queries and samples, and removes everyone's access to it. This can't be undone.")).toBeTruthy();
  });

  it('enables Delete only when the exact app name is typed', () => {
    const { dialog, confirm } = open();
    expect(confirm.disabled).toBe(true);
    const input = within(dialog).getByLabelText('Type Shop to confirm');
    fireEvent.change(input, { target: { value: 'shop' } });
    expect(confirm.disabled).toBe(true);
    fireEvent.change(input, { target: { value: 'Shop' } });
    expect(confirm.disabled).toBe(false);
    fireEvent.click(confirm);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('deletes and goes to the org home', async () => {
    fetchMock.mockResolvedValueOnce(reply(204));
    const { dialog, confirm } = open();
    fireEvent.change(within(dialog).getByLabelText('Type Shop to confirm'), { target: { value: 'Shop' } });
    fireEvent.click(confirm);
    await vi.waitFor(() => expect(router.replace).toHaveBeenCalledWith('/dashboard/acme'));
    expect(router.refresh).toHaveBeenCalled();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/apps/app1');
    expect(init.method).toBe('DELETE');
  });

  it('shows the BFF error and stays', async () => {
    fetchMock.mockResolvedValueOnce(reply(403, { error: 'Only workspace admins can delete apps.' }));
    const { dialog, confirm } = open();
    fireEvent.change(within(dialog).getByLabelText('Type Shop to confirm'), { target: { value: 'Shop' } });
    fireEvent.click(confirm);
    expect((await within(dialog).findByRole('alert')).textContent).toBe('Only workspace admins can delete apps.');
    expect(router.replace).not.toHaveBeenCalled();
    expect(screen.getByRole('alertdialog')).toBeTruthy();
  });

  it('cancelling clears the typed name and returns focus to the trigger', async () => {
    render(<DeleteApp appId="app1" appName="Shop" orgSlug="acme" />);
    const trigger = screen.getByRole('button', { name: 'Delete app' });
    trigger.focus();
    fireEvent.click(trigger);
    fireEvent.change(within(screen.getByRole('alertdialog')).getByLabelText('Type Shop to confirm'), { target: { value: 'Shop' } });
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Cancel' }));
    await vi.waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    await vi.waitFor(() => expect(document.activeElement).toBe(trigger));
    fireEvent.click(trigger);
    expect((within(screen.getByRole('alertdialog')).getByLabelText('Type Shop to confirm') as HTMLInputElement).value).toBe('');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
