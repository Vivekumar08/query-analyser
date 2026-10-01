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
