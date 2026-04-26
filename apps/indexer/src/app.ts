import { Hono } from 'hono';
import { handleHeliusWebhook } from './webhooks/handler.js';

export const app = new Hono();

// Health check — used by Fly.io and load balancers.
const startTime = Date.now();
app.get('/healthz', (c) => {
  return c.json({
    ok: true,
    version: process.env.npm_package_version ?? '0.1.0',
    uptime: Math.floor((Date.now() - startTime) / 1000),
  });
});

app.post('/webhooks/helius', handleHeliusWebhook);
