import Fastify, { type FastifyInstance, type FastifyError } from 'fastify';
import { loadConfig, type Config } from './config.js';
import { ingestRoutes } from './ingest/routes.js';
import { authRoutes } from './auth/routes.js';
import { orgRoutes } from './orgs/routes.js';
import { appRoutes } from './apps/routes.js';
import { inviteRoutes } from './orgs/invites.js';

export interface BuildOptions {
  logger?: boolean;
  config?: Config;
  /**
   * Per-IP requests/minute allowed on `POST /v1/ingest`. Defaults to 600 in
   * production. Exposed here only so tests can drive a rate-limit 429
   * without sending 600 real requests — never lower this in production.
   */
  rateLimitMax?: number;
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

  // Installed @fastify/compress (8.x) splits `global` into two independent
  // flags — `globalCompression` and `globalDecompression` — each defaulting
  // to `true` when `global` is unset. A bare `global: false` (as an older
  // README/brief suggested) disables BOTH, which silently breaks gzip
  // request bodies (Fastify's content-length check then fails because the
  // body was never decompressed). We only want to turn off *response*
  // compression, so we disable `globalCompression` and leave
  // `globalDecompression` at its default (true) — request decompression
  // still runs as an onRequest/preParsing hook on every route.
  await app.register(import('@fastify/compress'), {
    globalCompression: false,
    requestEncodings: ['gzip', 'deflate'],
    onUnsupportedRequestEncoding: (encoding) => {
      const err = new Error(`unsupported content-encoding: ${encoding}`) as FastifyError;
      err.statusCode = 415;
      return err;
    },
  });
  await app.register(import('@fastify/rate-limit'), {
    global: false,
    // The bucket key must never be derived from request content: an
    // attacker sending a fresh random `Authorization` header on every
    // request would get a brand-new bucket each time, so the limiter would
    // never engage — while every request still costs a KeyResolver.resolve
    // DB round-trip on a novel hash before returning 401. `req.ip` is the
    // only safe key (the socket address, or the real client address once a
    // deployment sets TRUST_PROXY to resolve it behind a trusted proxy).
    keyGenerator: (req) => req.ip,
  });
  await app.register(import('./plugins/prisma.js'));
  await app.register(import('./plugins/auth.js'));
  await app.register(ingestRoutes, { rateLimitMax: opts.rateLimitMax });
  await app.register(authRoutes);
  await app.register(orgRoutes);
  await app.register(appRoutes);
  await app.register(inviteRoutes);

  // Prisma returns BigInt for QueryRollup/QueryDailyRollup's `totalMs`
  // column, and JSON.stringify throws on a bare BigInt. Every route that
  // might ever return one already converts it to a plain number, but this
  // is a safety net: if a stray BigInt reaches a reply anyway, serialize it
  // as a string instead of crashing the response.
  app.setReplySerializer((payload) =>
    JSON.stringify(payload, (_key, value) => (typeof value === 'bigint' ? value.toString() : value)),
  );

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
