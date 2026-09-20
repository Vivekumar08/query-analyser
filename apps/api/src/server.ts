import 'dotenv/config';
import { buildApp } from './app.js';

const app = await buildApp();
const { PORT } = app.config;

const shutdown = async (signal: string) => {
  app.log.info({ signal }, 'shutting down');
  await app.close();
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

await app.listen({ port: PORT, host: '0.0.0.0' });
