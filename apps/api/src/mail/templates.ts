/**
 * Transactional email templates in the Mist style: the ◐ query·analyser
 * wordmark, a white card on a soft periwinkle haze, a serif headline and an
 * ink pill button.
 *
 * Email clients are not browsers, so this is deliberately old-fashioned:
 * table layout, inline styles, system/web-safe font stacks, and nothing
 * remote (no images, stylesheets or fonts) — the wordmark is text, so an
 * inbox that blocks images still shows the brand. Clients without gradient
 * support fall back to the flat base colour.
 *
 * Every value that reaches the html is escaped here; subjects are flattened
 * to one line (a CR/LF in a header is an injection vector).
 */

export interface RenderedMail {
  subject: string;
  text: string;
  html: string;
}

type Role = 'OWNER' | 'ADMIN' | 'MEMBER' | 'VIEWER';

const C = {
  base: '#F7F8FC',
  hazeBlue: '#DCE6FF',
  hazeLilac: '#EADFFB',
  ink: '#1E2235',
  muted: '#5A607A',
  caption: '#5C627C',
  accent: '#5259AC',
  border: '#E3E6F3',
  tint: '#EEF0FF',
} as const;

const SANS = "Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif";
const SERIF = "'Instrument Serif',Georgia,'Times New Roman',serif";

export const escapeHtml = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export const oneLine = (s: string): string => s.replace(/[\r\n]+/g, ' ');

/** "1 hour", "24 hours", "7 days", "30 minutes" — whole units only. */
export function formatTtl(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? '' : 's'}`;
  if (minutes >= 48 * 60 && minutes % (24 * 60) === 0) return plural(minutes / (24 * 60), 'day');
  if (minutes >= 60 && minutes % 60 === 0) return plural(minutes / 60, 'hour');
  return plural(Math.max(minutes, 1), 'minute');
}

const roleLabel = (r: Role) => r.charAt(0) + r.slice(1).toLowerCase();

interface Layout {
  /** Shown in the inbox list next to the subject. Plain text. */
  preheader: string;
  /** Small uppercase label above the headline. Plain text. */
  eyebrow: string;
  /** Headline html — callers escape any user value they put in it. */
  headlineHtml: string;
  /** Body paragraph html — callers escape any user value they put in it. */
  bodyHtml: string;
  cta: string;
  href: string;
  expiry: string;
  /** Optional callout html under the link, e.g. the reset reassurance. */
  noteHtml?: string;
  /** Why the recipient got this. Plain text. */
  footer: string;
}

function layout(l: Layout): string {
  const href = escapeHtml(l.href);
  const note = l.noteHtml
    ? `<tr><td style="padding:18px 0 0;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td style="background:${C.tint};border-radius:10px;padding:12px 14px;font-family:${SANS};font-size:13px;line-height:1.5;color:#3F4459;">${l.noteHtml}</td></tr></table></td></tr>`
    : '';
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
<title>${escapeHtml(l.eyebrow)}</title>
</head>
<body style="margin:0;padding:0;background:${C.base};-webkit-text-size-adjust:100%;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;mso-hide:all;">${escapeHtml(l.preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${C.base};background-image:radial-gradient(700px 360px at 90% 0%,${C.hazeBlue} 0%,${C.base} 60%),radial-gradient(600px 420px at 0% 60%,${C.hazeLilac} 0%,${C.base} 55%);">
<tr><td align="center" style="padding:40px 16px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:520px;">
<tr><td align="center" style="padding:0 0 20px;font-family:${SANS};font-size:16px;font-weight:600;letter-spacing:-0.01em;color:${C.ink};"><span style="color:${C.accent};">&#9680;</span> query·analyser</td></tr>
<tr><td style="background:#FFFFFF;border:1px solid ${C.border};border-radius:16px;padding:32px;box-shadow:0 24px 48px -12px rgba(80,90,160,0.14);">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
<tr><td style="font-family:${SANS};font-size:11px;font-weight:600;letter-spacing:0.08em;text-transform:uppercase;color:${C.accent};">${escapeHtml(l.eyebrow)}</td></tr>
<tr><td style="padding:10px 0 12px;font-family:${SERIF};font-size:28px;line-height:1.2;color:${C.ink};">${l.headlineHtml}</td></tr>
<tr><td style="padding:0 0 24px;font-family:${SANS};font-size:15px;line-height:1.6;color:${C.muted};">${l.bodyHtml}</td></tr>
<tr><td><table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td style="background:${C.ink};border-radius:999px;"><a href="${href}" target="_blank" style="display:inline-block;padding:12px 24px;font-family:${SANS};font-size:14px;font-weight:600;color:#FFFFFF;text-decoration:none;border-radius:999px;">${escapeHtml(l.cta)}</a></td></tr></table></td></tr>
<tr><td style="padding:24px 0 0;font-family:${SANS};font-size:12px;line-height:1.6;color:${C.caption};">This link expires in ${escapeHtml(l.expiry)}. Button not working? Paste this link into your browser:<br><a href="${href}" target="_blank" style="color:${C.accent};word-break:break-all;">${href}</a></td></tr>
${note}
</table>
</td></tr>
<tr><td align="center" style="padding:20px 8px 0;font-family:${SANS};font-size:12px;line-height:1.5;color:${C.caption};">${escapeHtml(l.footer)}</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;
}

const accentEm = (s: string) => `<em style="color:${C.accent};font-style:italic;">${s}</em>`;
const strong = (s: string) => `<strong style="color:${C.ink};font-weight:600;">${s}</strong>`;

export function verifyEmail(o: { href: string; email: string; ttlMs: number }): RenderedMail {
  const expiry = formatTtl(o.ttlMs);
  return {
    subject: 'Confirm your email',
    html: layout({
      preheader: 'Confirm your email to finish setting up Query Analyser.',
      eyebrow: 'Confirm your email',
      headlineHtml: `One click and ${accentEm("you're in")}`,
      bodyHtml: `Confirm ${strong(escapeHtml(o.email))} to finish setting up your account. Then add one line to your app and your slowest queries start showing up.`,
      cta: 'Confirm email',
      href: o.href,
      expiry,
      footer: "You got this because an account was created with this address. Didn't sign up? Ignore this email.",
    }),
    text: [
      'Confirm your email',
      '',
      `Confirm ${o.email} to finish setting up your Query Analyser account:`,
      '',
      o.href,
      '',
      `This link expires in ${expiry}.`,
      '',
      "Didn't sign up? Ignore this email.",
    ].join('\n'),
  };
}

export function resetPasswordEmail(o: { href: string; email: string; ttlMs: number }): RenderedMail {
  const expiry = formatTtl(o.ttlMs);
  return {
    subject: 'Reset your password',
    html: layout({
      preheader: `Choose a new password. The link expires in ${expiry}.`,
      eyebrow: 'Password reset',
      headlineHtml: `Set a ${accentEm('new password')}`,
      bodyHtml: `Someone asked to reset the password for ${strong(escapeHtml(o.email))}. If that was you, choose a new one below.`,
      cta: 'Reset password',
      href: o.href,
      expiry,
      noteHtml: `<strong style="color:${C.ink};">Didn't ask for this?</strong> Ignore this email. Your password stays the same.`,
      footer: 'Sent because a password reset was requested for this address.',
    }),
    text: [
      'Reset your password',
      '',
      `Someone asked to reset the password for ${o.email}. If that was you, choose a new one:`,
      '',
      o.href,
      '',
      `This link expires in ${expiry}.`,
      '',
      "Didn't ask for this? Ignore this email. Your password stays the same.",
    ].join('\n'),
  };
}

export function inviteEmail(o: {
  href: string;
  orgName: string;
  inviterName: string;
  role: Role;
  ttlMs: number;
  /** The app an app-scoped invite grants; omitted for an org-wide invite. */
  appName?: string;
}): RenderedMail {
  const expiry = formatTtl(o.ttlMs);
  const org = oneLine(o.orgName);
  const inviter = oneLine(o.inviterName);
  const role = roleLabel(o.role);
  const app = o.appName === undefined ? undefined : oneLine(o.appName);
  const subject = app === undefined
    ? `You're invited to ${org} on Query Analyser`
    : `You're invited to ${app} in ${org} on Query Analyser`;
  const sentence = app === undefined
    ? `${inviter} invited you as ${role} to see which MongoDB queries are slowing ${org} down, and why.`
    : `${inviter} invited you to ${app} in ${org} as ${role}, to see which MongoDB queries are slowing it down, and why.`;
  return {
    subject: oneLine(subject),
    html: layout({
      preheader: app === undefined
        ? `${inviter} invited you to ${org} on Query Analyser.`
        : `${inviter} invited you to ${app} in ${org} on Query Analyser.`,
      eyebrow: 'Team invite',
      headlineHtml: `Join ${accentEm(escapeHtml(org))} on query·analyser`,
      bodyHtml: app === undefined
        ? `${strong(escapeHtml(inviter))} invited you as ${strong(role)} to see which MongoDB queries are slowing ${escapeHtml(org)} down, and why.`
        : `${strong(escapeHtml(inviter))} invited you to ${strong(escapeHtml(app))} in ${strong(escapeHtml(org))} as ${strong(role)}, to see which MongoDB queries are slowing it down, and why.`,
      cta: 'Accept invite',
      href: o.href,
      expiry,
      footer: 'You got this because someone invited this address. Not expecting it? Ignore this email.',
    }),
    text: [
      subject,
      '',
      sentence,
      '',
      'Accept the invite:',
      '',
      o.href,
      '',
      `This link expires in ${expiry}.`,
      '',
      'Not expecting this? Ignore this email.',
    ].join('\n'),
  };
}
