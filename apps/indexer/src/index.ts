import { dotenvLoad } from 'dotenv-mono';

dotenvLoad();

import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { logger } from './logger.js';

export const app = new Hono();

app.post('/webhooks/helius', (c) => {
  return c.json({ ok: true });
});

const port = Number(process.env['PORT'] ?? 3001);

serve({ fetch: app.fetch, port }, () => {
  logger.info({ port }, 'indexer listening');
});
