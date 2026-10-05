import nodemailer from 'nodemailer';
import type { FastifyBaseLogger } from 'fastify';

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export interface MailerConfig {
  SMTP_HOST: string;
  SMTP_PORT: number;
  SMTP_SECURE: boolean;
  SMTP_USER: string;
  SMTP_PASS: string;
  SMTP_FROM_NAME: string;
}

export interface Mailer {
  send(msg: MailMessage): Promise<void>;
}

interface Transport {
  sendMail(options: Record<string, unknown>): Promise<unknown>;
}

/**
 * The only place in the codebase that knows an SMTP transport exists.
 *
 * Swapping Gmail for a transactional provider is a config change, not a code
 * change — which matters, because Gmail caps around 500 messages a day and
 * mail from a new sender lands in spam more often than a real provider's.
 *
 * `transport` is injectable so tests never open a connection.
 */
export function createMailer(
  config: MailerConfig,
  logger: FastifyBaseLogger,
  transport?: Transport,
): Mailer {
  const tx: Transport =
    transport ??
    nodemailer.createTransport({
      host: config.SMTP_HOST,
      port: config.SMTP_PORT,
      secure: config.SMTP_SECURE,
      auth: { user: config.SMTP_USER, pass: config.SMTP_PASS },
    });

  const from = `${config.SMTP_FROM_NAME} <${config.SMTP_USER}>`;

  return {
    async send(msg) {
      try {
        await tx.sendMail({ from, to: msg.to, subject: msg.subject, text: msg.text, html: msg.html });
      } catch (err) {
        // A provider's error text can quote the credentials it rejected, so
        // log the shape of the failure and never the error verbatim.
        logger.error(
          { to: msg.to, subject: msg.subject, err: err instanceof Error ? err.name : 'unknown' },
          'mail send failed',
        );
      }
    },
  };
}
