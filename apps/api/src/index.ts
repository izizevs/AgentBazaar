// AgentBazaar Discovery REST API — Hono on Cloudflare Workers
//
// Endpoints:
//   GET /healthz                          → health check
//   GET /listings                         → paginated listing search
//   GET /listings/:pubkey                 → single listing detail
//   GET /escrows/:pubkey                  → single escrow detail
//   GET /agents/:pubkey/reputation        → reputation snapshot
import { Hono } from 'hono';
import { corsMiddleware } from './middleware/cors.js';
import { rateLimitMiddleware } from './middleware/ratelimit.js';
import { agentsRouter } from './routes/agents.js';
import { escrowsRouter } from './routes/escrows.js';
import { listingsRouter } from './routes/listings.js';
import type { Bindings } from './types.js';

const app = new Hono<{ Bindings: Bindings }>();

// ---- Global middleware ---------------------------------------------------

app.use('*', corsMiddleware);
app.use('*', rateLimitMiddleware);

// ---- Health check --------------------------------------------------------

const startTime = Date.now();

app.get('/healthz', (c) => {
  const version = c.env.APP_VERSION ?? 'unknown';
  return c.json({
    ok: true,
    version,
    uptime: Math.floor((Date.now() - startTime) / 1000),
  });
});

// ---- Route mounts --------------------------------------------------------

app.route('/listings', listingsRouter);
app.route('/escrows', escrowsRouter);
app.route('/agents', agentsRouter);

// ---- 404 fallback --------------------------------------------------------

app.notFound((c) =>
  c.json({ error: 'not_found', message: `No route for ${c.req.method} ${c.req.path}` }, 404),
);

// ---- Error handler -------------------------------------------------------

app.onError((err, c) => {
  console.error('[api] unhandled error', err);
  return c.json({ error: 'internal_error', message: 'An unexpected error occurred' }, 500);
});

// CF Workers export
export default app;
