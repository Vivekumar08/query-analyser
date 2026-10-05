import { describe, it, expect, vi } from 'vitest';
import { createMailer } from './mailer.js';

const config = {
  SMTP_HOST: 'smtp.example.com',
  SMTP_PORT: 587,
  SMTP_SECURE: false,
  SMTP_USER: 'user@example.com',
  SMTP_PASS: 'secret-value',
  SMTP_FROM_NAME: 'Vigor Tempo',
};

const logger = () => ({ error: vi.fn(), info: vi.fn() });

describe('createMailer', () => {
  it('sends through the transport with a From built from the configured name', async () => {
    const sendMail = vi.fn().mockResolvedValue({ messageId: 'x' });
    const log = logger();
    const mailer = createMailer(config, log as never, { sendMail } as never);

    await mailer.send({ to: 'a@b.io', subject: 'Hello', text: 'Body' });

    expect(sendMail).toHaveBeenCalledTimes(1);
    const arg = sendMail.mock.calls[0]![0] as Record<string, string>;
    expect(arg.to).toBe('a@b.io');
    expect(arg.subject).toBe('Hello');
    expect(arg.from).toContain('Vigor Tempo');
    expect(arg.from).toContain('user@example.com');
  });

  it('never puts the password in a log line when the transport fails', async () => {
    const sendMail = vi.fn().mockRejectedValue(new Error('535 auth failed for secret-value'));
    const log = logger();
    const mailer = createMailer(config, log as never, { sendMail } as never);

    await mailer.send({ to: 'a@b.io', subject: 'S', text: 'T' });

    const logged = JSON.stringify(log.error.mock.calls);
    expect(logged).not.toContain('secret-value');
  });

  it('resolves rather than throwing when the transport fails', async () => {
    // A send failure must never fail the caller's request. Signup succeeding
    // and the mail being retryable is strictly better than losing the account.
    const sendMail = vi.fn().mockRejectedValue(new Error('connection refused'));
    const mailer = createMailer(config, logger() as never, { sendMail } as never);
    await expect(mailer.send({ to: 'a@b.io', subject: 'S', text: 'T' })).resolves.toBeUndefined();
  });
});
