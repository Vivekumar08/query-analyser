import Fastify, { type FastifyInstance, type FastifyError } from 'fastify';
import { loadConfig, type Config } from './config.js';

export interface BuildOptions {
  logger?: boolean;
  config?: Config;
}

/**
 * Fastify's `trustProxy` option accepts a boolean or a CIDR/IP list. Our env
 * schema only ever gives us a string, so map the two boolean literals and
 * pass anything else (a comma-separated list) straight through to Fastify,
 * which parses it itself.
 */
export function parseTrustProxy(value: string): boolean | string {
  if (value === 'true') return true;
  if (value === 'false') return false;
  return value;
}

/**
 * Fastify types the error handler's first argument as `FastifyError`, but at
 * runtime a route (or a dependency) can `throw` anything — `null`, a string,
 * a plain object. Coerce anything that isn't error-shaped into a real `Error`
 * so the handler below never dereferences a property on `null`/`undefined`,
 * and never lets a plain-object throw fall through to Fastify's own fallback
 * handler (which would leak the internal message regardless of status).
 */
function toFastifyError(err: unknown): FastifyError {
  if (err instanceof Error) return err as FastifyError;
  if (typeof err === 'object' && err !== null && 'message' in err) {
    return err as FastifyError;
  }
  return new Error(String(err)) as FastifyError;
}

export async function buildApp(opts: BuildOptions = {}): Promise<FastifyInstance> {
  const config = opts.config ?? loadConfig();
  const app = Fastify({
    logger: opts.logger === false ? false : { level: config.LOG_LEVEL },
    trustProxy: parseTrustProxy(config.TRUST_PROXY),
  });

  app.decorate('config', config);

  app.get('/healthz', async () => ({ status: 'ok' }));

  app.setNotFoundHandler((_req, reply) => {
    void reply.code(404).send({ error: 'Not Found' });
  });

  app.setErrorHandler((rawErr: unknown, req, reply) => {
    const err = toFastifyError(rawErr);
    const status = err.statusCode ?? 500;
    if (status >= 500) req.log.error({ err }, 'unhandled error');
    void reply.code(status).send({ error: status >= 500 ? 'Internal Server Error' : err.message });
  });

  return app;
}

declare module 'fastify' {
  interface FastifyInstance { config: Config; }
}
