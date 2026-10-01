import 'dotenv/config';
import { buildApp } from './app.js';
import { createShutdownHandler } from './shutdown.js';

const app = await buildApp();
const { PORT } = app.config;

const shutdown = createShutdownHandler({
  close: () => app.close(),
  log: app.log,
  exit: (code) => process.exit(code),
});
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

await app.listen({ port: PORT, host: '0.0.0.0' });
