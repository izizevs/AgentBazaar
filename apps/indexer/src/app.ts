import { Hono } from 'hono';
import { handleHeliusWebhook } from './webhooks/handler.js';

export const app = new Hono();

app.post('/webhooks/helius', handleHeliusWebhook);
