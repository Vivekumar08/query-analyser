import Fastify, { type FastifyInstance, type FastifyError } from 'fastify';
import { loadConfig, type Config } from './config.js';
import { ingestRoutes } from './ingest/routes.js';
import { authRoutes } from './auth/routes.js';
import { orgRoutes } from './orgs/routes.js';
import { appRoutes } from './apps/routes.js';
import { inviteRoutes } from './orgs/invites.js';
import { adminRoutes } from './admin/routes.js';

export interface BuildOptions {
  logger?: boolean;
  config?: Config;
  /**
   * Per-IP requests/minute allowed on `POST /v1/ingest`. Defaults to 600 in
   * production. Exposed here only so tests can drive a rate-limit 429
   * without sending 600 real requests — never lower this in production.
   */
  rateLimitMax?: number;
  /**
   * Test-only: a writable stream pino writes log lines to, instead of the
   * default destination. Lets a test capture emitted request logs (e.g. to
   * assert the invite-accept token never appears in one) without touching
   * stdout. Ignored when `logger` is `false`.
   */
  logStream?: NodeJS.WritableStream;
  /**
   * Starts the in-process analysis scheduler's timers. Defaults to `false`
   * so the dozens of apps the test suite builds never spawn background
   * work; `server.ts` passes `true`.
   */
  startScheduler?: boolean;
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
 * The invite-accept route is the first (and so far only) place in this repo
 * that carries a bearer credential in the URL path rather than a header —
 * ingest keys always travel in a header, which Fastify's default request
 * log never includes. Fastify's default `req` serializer logs `req.url`
 * verbatim (see `fastify/lib/logger-pino.js`), and it runs on *every*
 * request, before the route handler — so even a 404/403/410 attempt against
 * `/v1/invites/:token/accept` would otherwise write the live token to the
 * request log. Match that path shape and blank out the token segment only;
 * every other URL is logged unchanged.
 */
const ACCEPT_INVITE_URL = /^(\/v1\/invites\/)[^/?]+(\/accept(?:\?.*)?)$/;

function redactAcceptInviteUrl(url: string): string {
  return url.replace(ACCEPT_INVITE_URL, '$1[redacted]$2');
}

/**
 * Mirrors Fastify's own default `req` serializer (fastify/lib/logger-pino.js)
 * field-for-field, so every other route's request log is byte-identical to
 * the framework default — the only change is routing `url` through
 * `redactAcceptInviteUrl` first.
 */
function reqSerializer(req: {
  method: string;
  url: string;
  headers?: Record<string, string | string[] | undefined>;
  host?: string;
  ip?: string;
  socket?: { remotePort?: number };
}) {
  const version = req.headers?.['accept-version'];
  return {
    method: req.method,
    url: redactAcceptInviteUrl(req.url),
    version: typeof version === 'string' ? version : undefined,
    host: req.host,
    remoteAddress: req.ip,
    remotePort: req.socket ? req.socket.remotePort : undefined,
  };
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
    logger:
      opts.logger === false
        ? false
        : {
            level: config.LOG_LEVEL,
            serializers: { req: reqSerializer },
            ...(opts.logStream ? { stream: opts.logStream } : {}),
          },
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
  // These three must be registered BEFORE any `app.register(...)` calls for
  // route plugins below. Fastify snapshots `kErrorHandler` and
  // `kReplySerializerDefault` into each route's context as the enclosing
  // `register()` call resolves (i.e. at the moment the child encapsulation
  // context is created), not dynamically at request time. A `set*` call
  // made *after* a plugin has been registered only affects routes declared
  // directly on the root instance afterwards (e.g. `/healthz`) — every
  // route inside `ingestRoutes`, `authRoutes`, etc. would silently keep
  // Fastify's own default error handler / reply serializer instead of ours.
  //
  // Prisma returns BigInt for QueryRollup/QueryDailyRollup's `totalMs`
  // column, and JSON.stringify throws on a bare BigInt. Every route that
  // might ever return one already converts it to a plain number, but this
  // is a safety net: if a stray BigInt reaches a reply anyway, serialize it
  // as a string instead of crashing the response.
  app.setReplySerializer((payload) =>
    JSON.stringify(payload, (_key, value) => (typeof value === 'bigint' ? value.toString() : value)),
  );

  app.setNotFoundHandler((_req, reply) => {
    void reply.code(404).send({ error: 'Not Found' });
  });

  app.setErrorHandler((rawErr: unknown, req, reply) => {
    const err = toFastifyError(rawErr);
    const status = err.statusCode ?? 500;
    if (status >= 500) req.log.error({ err }, 'unhandled error');
    void reply.code(status).send({ error: status >= 500 ? 'Internal Server Error' : err.message });
  });

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
  await app.register(import('./analysis/scheduler.js'), {
    startScheduler: opts.startScheduler ?? false,
  });
  await app.register(import('./plugins/auth.js'));
  await app.register(ingestRoutes, { rateLimitMax: opts.rateLimitMax });
  await app.register(authRoutes);
  await app.register(orgRoutes);
  await app.register(appRoutes);
  await app.register(inviteRoutes);
  await app.register(adminRoutes);
  await app.register(import('./analysis/routes.js'));

  app.get('/healthz', async () => ({ status: 'ok' }));

  return app;
}

declare module 'fastify' {
  interface FastifyInstance { config: Config; }
}
