import { serve } from '@hono/node-server';
import { app } from './app.js';
import { startRetentionCron } from './cron/retention.js';
import { getEnv } from './env.js';
import { logger } from './logger.js';

const env = getEnv();

// Start TTL retention cron for processed_signatures.
// RETENTION_INTERVAL_MS=0 disables it (set in tests).
startRetentionCron(env.RETENTION_INTERVAL_MS);

serve({ fetch: app.fetch, port: env.PORT }, () => {
  logger.info({ port: env.PORT }, 'indexer listening');
});
