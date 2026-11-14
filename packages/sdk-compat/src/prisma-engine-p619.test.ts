import { engineSuite, registerPrismaHooks } from './prisma-suite.js';

// Prisma p619's library engine paths in their own file, so the engine loads in its own vitest worker.
registerPrismaHooks();
engineSuite('p619');
