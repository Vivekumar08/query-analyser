/**
 * Writes every transactional email to .email-preview/ as html and text so
 * the designs can be checked in a browser before a deploy:
 *
 *   pnpm --filter @query-analyser/api email:preview
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { inviteEmail, resetPasswordEmail, verifyEmail } from '../src/mail/templates.js';
import { RESET_TTL_MS, VERIFY_TTL_MS } from '../src/auth/verification.js';

const origin = 'https://app.example.test';
const out = path.resolve(process.cwd(), '.email-preview');
mkdirSync(out, { recursive: true });

const mails = {
  verify: verifyEmail({ href: `${origin}/verify?token=preview-token`, email: 'ada@example.test', ttlMs: VERIFY_TTL_MS }),
  reset: resetPasswordEmail({ href: `${origin}/reset-password?token=preview-token`, email: 'ada@example.test', ttlMs: RESET_TTL_MS }),
  invite: inviteEmail({
    href: `${origin}/invite?token=preview-token`,
    orgName: 'Kisna',
    appName: 'Shop',
    inviterName: 'Vivek Kumar',
    role: 'MEMBER',
    ttlMs: 7 * 24 * 3600 * 1000,
  }),
};

for (const [name, mail] of Object.entries(mails)) {
  writeFileSync(path.join(out, `${name}.html`), mail.html);
  writeFileSync(path.join(out, `${name}.txt`), `Subject: ${mail.subject}\n\n${mail.text}\n`);
  console.log(`${name.padEnd(7)} ${path.join(out, `${name}.html`)}`);
}
