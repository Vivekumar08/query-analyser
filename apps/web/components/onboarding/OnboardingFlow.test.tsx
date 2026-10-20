// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { OnboardingFlow } from './OnboardingFlow';

vi.mock('./OrgStep', () => ({
  OrgStep: ({ onCreated }: { onCreated: (slug: string) => void }) => (
    <button type="button" onClick={() => onCreated('acme-co')}>create</button>
  ),
}));
vi.mock('./AppStep', () => ({ AppStep: ({ org }: { org: string }) => <p>{org}</p> }));
vi.mock('@/app/_components/ContinueToInvite', () => ({
  usePendingInvite: () => null,
  ContinueToInviteLink: () => null,
}));

afterEach(cleanup);

describe('OnboardingFlow', () => {
  it('after the org is created, the URL names it, so a reload resumes at its app step', () => {
    window.history.replaceState(null, '', '/onboarding?new=org');
    render(<OnboardingFlow start={{ step: 'org' }} email="a@x.io" />);
    fireEvent.click(screen.getByRole('button', { name: 'create' }));
    expect(window.location.pathname + window.location.search).toBe('/onboarding?org=acme-co');
    expect(screen.getByText('acme-co')).toBeTruthy();
  });
});
