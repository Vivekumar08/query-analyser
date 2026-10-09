import { z } from 'zod';

const schema = z.object({
  DATABASE_URL: z.string().url(),
  JWT_SECRET: z.string().min(32),
  COOKIE_SECRET: z.string().min(32),
  PORT: z.coerce.number().int().positive().default(8080),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  NODE_ENV: z.string().default('development'),
  // 'false' (default): never trust X-Forwarded-*; 'true': trust it unconditionally
  // (only when a trusted proxy terminates TLS in front of this service); or a
  // comma-separated list of trusted proxy IPs/CIDRs, which Fastify parses itself.
  TRUST_PROXY: z.string().default('false'),
  SMTP_HOST: z.string().min(1),
  SMTP_PORT: z.coerce.number().int().positive().default(587),
  SMTP_SECURE: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
  SMTP_USER: z.string().min(1),
  SMTP_PASS: z.string().min(1),
  SMTP_FROM_NAME: z.string().min(1).default('Vigor Tempo'),
  // Origin of the web app the emailed links point at. The API never serves
  // these paths; it only ever receives the token back in a POST body.
  //
  // No default: there is no web app in this repo yet, so a default here would
  // silently ship production emails containing a localhost link. A deploy
  // must choose this explicitly or fail loudly at boot.
  WEB_ORIGIN: z.string().url(),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const missing = parsed.error.issues.map((i) => i.path.join('.')).join(', ');
    throw new Error(`invalid configuration: ${missing}`);
  }
  return parsed.data;
}
