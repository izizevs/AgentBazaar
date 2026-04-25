import { serve } from '@hono/node-server';
import { app } from './app.js';
import { getEnv } from './env.js';
import { logger } from './logger.js';

const env = getEnv();
serve({ fetch: app.fetch, port: env.PORT }, () => {
  logger.info({ port: env.PORT }, 'indexer listening');
});
