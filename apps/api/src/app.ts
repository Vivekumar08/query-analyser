import Fastify, { type FastifyInstance, type FastifyError } from 'fastify';
import { loadConfig, type Config } from './config.js';

export interface BuildOptions {
  logger?: boolean;
  config?: Config;
}

export async function buildApp(opts: BuildOptions = {}): Promise<FastifyInstance> {
  const config = opts.config ?? loadConfig();
  const app = Fastify({
    logger: opts.logger === false ? false : { level: config.LOG_LEVEL },
    trustProxy: true,
  });

  app.decorate('config', config);

  app.get('/healthz', async () => ({ status: 'ok' }));

  app.setNotFoundHandler((_req, reply) => {
    void reply.code(404).send({ error: 'Not Found' });
  });

  app.setErrorHandler((err: FastifyError, req, reply) => {
    const status = err.statusCode ?? 500;
    if (status >= 500) req.log.error({ err }, 'unhandled error');
    void reply.code(status).send({ error: status >= 500 ? 'Internal Server Error' : err.message });
  });

  return app;
}

declare module 'fastify' {
  interface FastifyInstance { config: Config; }
}
